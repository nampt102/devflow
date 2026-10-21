#!/usr/bin/env node
// Sets up the runner the Dev agent works in (change add-dev-stage). Safe to run again.
//   1. creates the SSH key pair in docker/runner/keys (kept out of git) if it is missing;
//   2. builds and starts the runner and the allow-list proxy (docker/docker-compose.runner.yml);
//   3. stores the private key as a company secret and creates or updates the Paperclip SSH environment
//      "devflow-runner" of the company, with the runner's host key pinned, then probes it.
//
//   node scripts/devflow/setup-dev-runner.mjs --company <companyId> [--no-docker]
//
// Env (local only; see docker/.env.example): PAPERCLIP_URL (default http://localhost:3100),
// DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD (an instance admin). --no-docker skips step 2 (the runner is already up).
// Prints the environment id, which the Dev agent setup binds the agent to.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dockerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docker");
const keyDir = path.join(dockerDir, "runner", "keys");
const keyFile = path.join(keyDir, "runner_key");
const SECRET_NAME = "devflow-runner-ssh-key";
const ENV_NAME = "devflow-runner";
const RUNNER_HOST = "devflow-runner";
const WORKSPACE = "/paperclip/devflow/ws";

const args = process.argv.slice(2);
const companyId = args[args.indexOf("--company") + 1];
if (!companyId || companyId.startsWith("--")) {
  console.error("Usage: setup-dev-runner.mjs --company <companyId> [--no-docker]");
  process.exit(2);
}
const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(2);
  }
  return v;
};
const compose = (...rest) =>
  ["-f", "docker-compose.yml", "-f", "docker-compose.devflow.yml", "-f", "docker-compose.runner.yml", ...rest];
const docker = (...rest) => execFileSync("docker", ["compose", ...compose(...rest)], { cwd: dockerDir, encoding: "utf8" });

// 1. key pair
if (!fs.existsSync(keyFile)) {
  fs.mkdirSync(keyDir, { recursive: true });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "devflow-runner", "-f", keyFile]);
  console.log("created the runner SSH key pair in docker/runner/keys");
}
// the compose file mounts it under this name
fs.copyFileSync(`${keyFile}.pub`, path.join(keyDir, "runner_key.pub"));

// 2. containers
if (!args.includes("--no-docker")) {
  const up = spawnSync("docker", ["compose", ...compose("up", "-d", "--build", "devflow-runner", "devflow-proxy", "server")], { cwd: dockerDir, stdio: "inherit" });
  if (up.status !== 0) process.exit(up.status ?? 1);
}

// From the runner, through the proxy: an allowed host answers, any other is refused. Squid sometimes starts before
// Docker's DNS is ready on the new network and then cannot resolve names; restarting it once fixes that.
const viaProxy = (host) => {
  try {
    return docker("exec", "-T", "devflow-runner", "curl", "-s", "-m", "15", "-x", "http://devflow-proxy:3128", "-o", "/dev/null", "-w", "%{http_code}", `https://${host}`).trim();
  } catch (e) {
    return String(e.stdout ?? "").trim() || "000";
  }
};
if (!args.includes("--no-docker")) {
  for (let attempt = 0; viaProxy("api.github.com") === "000" && attempt < 2; attempt++) docker("restart", "devflow-proxy");
}
if (viaProxy("api.github.com") === "000" || viaProxy("example.com") !== "000") {
  console.error("The runner network check failed: api.github.com must be reachable and example.com refused through devflow-proxy.");
  process.exit(1);
}

// the host key, pinned so Paperclip refuses an impostor on the runner network
let hostKey = "";
for (let i = 0; i < 30 && !hostKey; i++) {
  try {
    hostKey = docker("exec", "-T", "devflow-runner", "cat", "/etc/ssh/hostkeys/ssh_host_ed25519_key.pub").trim().split(/\s+/).slice(0, 2).join(" ");
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!hostKey) {
  console.error("The runner did not start: see `docker compose logs devflow-runner`.");
  process.exit(1);
}
const knownHosts = `${RUNNER_HOST} ${hostKey}`;

// 3. Paperclip
const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
let cookie = "";
async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
const must = (r, what) => {
  if (r.status >= 300) {
    console.error(`${what} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    process.exit(1);
  }
  return r.body;
};
const items = (b) => (Array.isArray(b) ? b : b?.items ?? []);

// the server was just recreated to join the runner network: wait until it answers
for (let i = 0; i < 90; i++) {
  if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 2000));
}

must(await call("POST", "/api/auth/sign-in/email", { email: need("DEVFLOW_TEST_ADMIN_EMAIL"), password: need("DEVFLOW_TEST_ADMIN_PASSWORD") }), "sign-in");
const privateKey = fs.readFileSync(keyFile, "utf8");

let secret = items(must(await call("GET", `/api/companies/${companyId}/secrets`), "list secrets")).find((s) => s.name === SECRET_NAME && s.status !== "deleted");
if (secret) {
  must(await call("POST", `/api/secrets/${secret.id}/rotate`, { value: privateKey }), "rotate the key secret");
} else {
  secret = must(await call("POST", `/api/companies/${companyId}/secrets`, { name: SECRET_NAME, value: privateKey, description: "SSH key of the DevFlow Dev runner" }), "create the key secret");
}

const config = {
  host: RUNNER_HOST,
  port: 22,
  username: "runner",
  remoteWorkspacePath: WORKSPACE,
  privateKeySecretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
  knownHosts,
  strictHostKeyChecking: true,
};
let environment = items(must(await call("GET", `/api/companies/${companyId}/environments`), "list environments")).find((e) => e.name === ENV_NAME);
if (environment) {
  environment = must(await call("PATCH", `/api/environments/${environment.id}`, { config }), "update the environment");
} else {
  environment = must(await call("POST", `/api/companies/${companyId}/environments`, { name: ENV_NAME, driver: "ssh", config }), "create the environment");
}

const probe = must(await call("POST", `/api/environments/${environment.id}/probe`, {}), "probe the environment");
if (probe.ok !== true) {
  console.error(`The runner did not pass the probe: ${JSON.stringify(probe).slice(0, 400)}`);
  process.exit(1);
}
console.log(`runner ready: environment ${environment.id} (host key pinned, probe ok)`);
console.log(`DEVFLOW_RUNNER_ENVIRONMENT_ID=${environment.id}`);
