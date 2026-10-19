#!/usr/bin/env node
// Creates or updates the BA agent of a company so it is exactly what DevFlow expects (read-only tools, its own
// workspace folder, a spend limit per run, current instructions). Safe to run again: run it after every upgrade
// that changes the BA prompt, or when the BA worker reports `agent_prompt_outdated`.
//
//   node scripts/devflow/setup-ba-agent.mjs --company <companyId>
//
// Env (local only; see docker/.env.example):
//   PAPERCLIP_URL                          default http://localhost:3100
//   DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD      a board user with access to the company (staff)
//   DEVFLOW_AGENT_ANTHROPIC_API_KEY        the Anthropic key the agent uses; stored as a company secret
//                                          (needed the first time, and to replace the key)
// What the agent should look like comes from the server (GET /api/companies/:id/devflow/ba-agent), so this
// script never drifts from the code.
const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const args = process.argv.slice(2);
const companyId = args[args.indexOf("--company") + 1];
if (!companyId || companyId.startsWith("--")) {
  console.error("Usage: setup-ba-agent.mjs --company <companyId>");
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

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(base + path, {
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

must(await call("POST", "/api/auth/sign-in/email", { email: need("DEVFLOW_TEST_ADMIN_EMAIL"), password: need("DEVFLOW_TEST_ADMIN_PASSWORD") }), "sign-in");
const state = must(await call("GET", `/api/companies/${companyId}/devflow/ba-agent`), "read BA agent setup");
const { spec } = state;

// The Anthropic key, as a company secret the agent refers to (a plain value in the agent config is refused).
const SECRET_NAME = "devflow-ba-anthropic";
const secretList = must(await call("GET", `/api/companies/${companyId}/secrets`), "list secrets");
const secrets = Array.isArray(secretList) ? secretList : secretList.items ?? [];
let secret = secrets.find((s) => s.name === SECRET_NAME && s.status !== "deleted");
const key = process.env.DEVFLOW_AGENT_ANTHROPIC_API_KEY;
if (!secret) {
  if (!key) {
    console.error("The agent needs an Anthropic key: set DEVFLOW_AGENT_ANTHROPIC_API_KEY and run again.");
    process.exit(2);
  }
  secret = must(await call("POST", `/api/companies/${companyId}/secrets`, { name: SECRET_NAME, value: key, description: "Anthropic key for the DevFlow BA agent" }), "create secret");
  console.log("stored the Anthropic key as a company secret");
} else if (key) {
  must(await call("POST", `/api/secrets/${secret.id}/rotate`, { value: key }), "rotate secret");
  console.log("replaced the stored Anthropic key");
}

const adapterConfig = { ...spec.adapterConfig, env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } } };
let agentId = state.agent?.id;
if (!agentId) {
  const created = must(
    await call("POST", `/api/companies/${companyId}/agents`, {
      name: spec.name,
      role: "general",
      title: "BA Spec (DevFlow)",
      capabilities: "Writes the draft BA spec for a request from its business documents and code. Read-only; a person reviews every spec.",
      adapterType: spec.adapterType,
      adapterConfig,
      runtimeConfig: spec.runtimeConfig,
      metadata: spec.metadata,
      instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": spec.instructions } },
    }),
    "create agent",
  );
  agentId = created.id;
  console.log(`created agent ${agentId}`);
  // a new agent can start paused; DevFlow only runs agents that are on
  if (created.status && created.status !== "idle") must(await call("PATCH", `/api/agents/${agentId}`, { status: "idle" }), "switch the agent on");
} else {
  must(await call("PATCH", `/api/agents/${agentId}`, { adapterConfig, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, replaceAdapterConfig: true, status: "idle" }), "update agent");
  const file = must(await call("GET", `/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`), "read instructions");
  if (file.content !== spec.instructions) {
    must(await call("PUT", `/api/agents/${agentId}/instructions-bundle/file`, { path: "AGENTS.md", content: spec.instructions, baseHash: file.contentHash ?? null }), "update instructions");
    console.log("updated the instructions");
  }
  console.log(`updated agent ${agentId}`);
}

const after = must(await call("GET", `/api/companies/${companyId}/devflow/ba-agent`), "check BA agent");
if (after.agent?.problem) {
  console.error(`The agent is set up but DevFlow would still refuse to run it: ${after.agent.problem}`);
  process.exit(1);
}
console.log(`BA agent ready (prompt ${spec.promptVersion}). It will pick up requests that reach BA Spec.`);
