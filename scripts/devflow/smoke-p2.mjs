#!/usr/bin/env node
// P2 acceptance smoke test against a running DevFlow instance: a requester files a request, Triage proposes, staff
// approve it and assign a system (a GitHub repository), the BA agent reads that repository and drafts a spec with
// citations, and staff approve the spec.
//
//   node scripts/devflow/smoke-p2.mjs [--system devflow] [--repo https://github.com/owner/repo] [--branch main] [--docs docs]
//                                     [--wait 180] [--wait-ba 900]
//
// Env (local test accounts only; see docker/.env.example): as smoke-p1.mjs, plus the BA agent must be set up for the
// company (node scripts/devflow/setup-ba-agent.mjs --company <id>) and the Triage and BA workers must be running.
// It creates one real request, adds the system if the company has none with that key, and spends real model money
// (the BA agent has a per-run and a per-day cap). Run it on a test or pilot-staging company.
// Each sign-in waits 11 s because better-auth limits sign-ins per address.
const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const systemKey = opt("system", "devflow");
const repoUrl = opt("repo", "https://github.com/nampt102/devflow");
const branch = opt("branch", "main");
const docsPath = opt("docs", "docs");
const waitSeconds = Number(opt("wait", "180")) || 180;
const waitBaSeconds = Number(opt("wait-ba", "900")) || 900;
const env = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}`);
    process.exit(2);
  }
  return v;
};

function client() {
  let cookie = "";
  return async (method, path, body) => {
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
  };
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 240)}`}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abort = (why) => {
  console.log(`\nStopped: ${why}`);
  console.log(`${failures} check(s) failed`);
  process.exit(1);
};

const staff = client();
const requester = client();

let r = await staff("POST", "/api/auth/sign-in/email", { email: env("DEVFLOW_TEST_ADMIN_EMAIL"), password: env("DEVFLOW_TEST_ADMIN_PASSWORD") });
if (!check("staff signs in", r.status === 200, r.status)) abort("cannot sign in as staff");
await sleep(11_000);
r = await requester("POST", "/api/auth/sign-in/email", { email: env("DEVFLOW_TEST_PORTAL_EMAIL"), password: env("DEVFLOW_TEST_PORTAL_PASSWORD") });
if (!check("requester signs in", r.status === 200, r.status)) abort("cannot sign in as requester");
r = await requester("GET", "/api/portal/me");
const companyId = r.body?.companyId;
if (!check("requester belongs to a company", r.status === 200 && !!companyId, r.status)) abort("requester has no company");
const api = (suffix) => `/api/companies/${companyId}/devflow/${suffix}`;

// the BA agent must be set up and exactly as safe as specified
r = await staff("GET", api("ba-agent"));
if (!check("the company has a BA agent that DevFlow would run", r.status === 200 && r.body?.agent && r.body.agent.problem === null, JSON.stringify(r.body?.agent ?? null))) {
  abort(`set it up first: node scripts/devflow/setup-ba-agent.mjs --company ${companyId}`);
}

// the system (repository) the BA agent will read
r = await staff("GET", api("systems"));
let system = r.body?.items?.find((s) => s.key === systemKey);
if (!system) {
  r = await staff("POST", api("systems"), { key: systemKey, name: systemKey, repoUrl, defaultBranch: branch, docsPath, description: "Smoke test system" });
  if (!check(`staff adds the system ${systemKey}`, r.status === 201, `${r.status} ${JSON.stringify(r.body)}`)) abort("cannot add the system");
  system = r.body;
} else {
  check(`the system ${systemKey} already exists`, system.active, "it is switched off: switch it on or use --system");
}
check("the system listing hides the token", !JSON.stringify(system).match(/token_?secret/i), JSON.stringify(system));

r = await requester("GET", `/api/companies/${companyId}/devflow/systems`);
check("requester cannot read the systems", r.status === 403 || r.status === 404, r.status);
r = await requester("GET", api("ba-queue"));
check("requester cannot read the BA queue", r.status === 403 || r.status === 404, r.status);

const baBefore = (await staff("GET", api("ba-metrics?days=1"))).body;
const title = `P2 smoke ${new Date().toISOString().slice(0, 19)}`;
r = await requester("POST", "/api/portal/requests", {
  title,
  description: "Người yêu cầu muốn thấy tên nhân viên đang xử lý yêu cầu của mình ngay trên cổng, để biết hỏi ai khi cần. (kiểm tra tự động, có thể bỏ qua)",
});
if (!check("requester files a request", r.status === 201 && Number.isInteger(r.body?.number), `${r.status} ${JSON.stringify(r.body)}`)) abort("submit failed");
const number = r.body.number;

// Triage proposes
let item = null;
let deadline = Date.now() + waitSeconds * 1000;
while (Date.now() < deadline) {
  r = await staff("GET", api("triage-queue"));
  item = r.body?.items?.find((i) => i.requestNumber === number) ?? null;
  if (item) break;
  await sleep(5000);
}
if (!check(`Triage proposes within ${waitSeconds}s`, !!item, "is the Triage worker running (DEVFLOW_LLM_*)?")) abort("no proposal");
r = await staff("GET", api(`triage-cases/${item.caseId}`));
const detail = r.body;
check("the triage detail offers the system", detail?.systems?.available?.some((s) => s.id === system.id), JSON.stringify(detail?.systems));
check("the suggestion names only systems that exist", (detail?.systems?.suggestedKeys ?? []).every((k) => detail.systems.available.some((s) => s.key === k)), JSON.stringify(detail?.systems?.suggestedKeys));

// approve and assign the system
r = await staff("POST", api(`triage-cases/${item.caseId}/decision`), {
  outputId: detail.outputId,
  expectedVersion: detail.version,
  decision: "approve",
  final: { duplicateOfCaseId: null },
  systemIds: [system.id],
});
check("staff approves and assigns the system", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
r = await requester("GET", `/api/portal/requests/${number}`);
check("requester sees the BA status", r.body?.statusLabel === "Đang phân tích nghiệp vụ", r.body?.statusLabel);

// the BA agent reads the repository and drafts a spec
let ba = null;
deadline = Date.now() + waitBaSeconds * 1000;
while (Date.now() < deadline) {
  r = await staff("GET", api("ba-queue"));
  ba = r.body?.items?.find((i) => i.requestNumber === number) ?? null;
  if (ba) break;
  await sleep(10_000);
}
if (!check(`the BA agent drafts a spec within ${waitBaSeconds}s`, !!ba, "is the BA worker running, the agent set up, and the daily spend cap not reached? see ba-metrics recentFailures")) {
  const m = (await staff("GET", api("ba-metrics?days=1"))).body;
  console.log("recent BA problems:", JSON.stringify(m?.recentFailures ?? []));
  abort("no BA spec");
}
r = await requester("GET", `/api/portal/requests/${number}`);
check("requester sees the review status without the spec", r.status === 200 && !JSON.stringify(r.body).includes("acceptanceCriteria") && !JSON.stringify(r.body).includes(ba.outputId), JSON.stringify(r.body).slice(0, 200));

r = await staff("GET", api(`ba-cases/${ba.caseId}`));
const spec = r.body;
check("staff opens the BA detail", r.status === 200 && spec.outputId === ba.outputId, r.status);
check("the spec has what a reviewer needs", !!spec.spec?.summary && spec.spec.inScope?.length > 0 && spec.spec.acceptanceCriteria?.length > 0 && ["low", "medium", "high"].includes(spec.spec.confidence), JSON.stringify(spec.spec).slice(0, 300));
check("the agent read the system at a commit", spec.repos?.some((x) => x.system === systemKey && /^[0-9a-f]{40}$/.test(x.sha) && x.repoUrl === system.repoUrl), JSON.stringify(spec.repos));
const cites = spec.spec?.affectedAreas ?? [];
check("the spec cites code of that system", cites.length > 0 && cites.every((c) => c.system === systemKey && c.path && !c.path.includes("..")), JSON.stringify(cites.slice(0, 3)));
check("the run cost was recorded", typeof spec.costUsd === "number" && spec.costUsd > 0, spec.costUsd);
console.log(`      spec: ${spec.spec?.summary?.slice(0, 160)}`);
console.log(`      cost: ${spec.costUsd} USD, ${cites.length} citation(s), model ${spec.model}`);

// approve with one correction
r = await staff("POST", api(`ba-cases/${ba.caseId}/decision`), {
  outputId: spec.outputId,
  expectedVersion: spec.version,
  decision: "approve",
  final: { summary: `${spec.spec.summary} (đã duyệt bởi kiểm tra tự động)`.slice(0, 800) },
});
check("staff approves the spec with a correction", r.status === 200 && r.body.overriddenFields?.includes("summary"), `${r.status} ${JSON.stringify(r.body)}`);
r = await staff("POST", api(`ba-cases/${ba.caseId}/decision`), { outputId: spec.outputId, expectedVersion: spec.version, decision: "approve" });
check("a second decision on the same spec is refused", r.status === 409 || r.status === 404, r.status);

const baAfter = (await staff("GET", api("ba-metrics?days=1"))).body;
check("metrics count the approval", baAfter?.approved?.total === (baBefore?.approved?.total ?? 0) + 1, `before=${baBefore?.approved?.total} after=${baAfter?.approved?.total}`);
check("metrics count the spend", (baAfter?.agent?.spendUsd ?? 0) > (baBefore?.agent?.spendUsd ?? 0), `${baBefore?.agent?.spendUsd} -> ${baAfter?.agent?.spendUsd}`);

console.log(`\nREQ ${number} ("${title}") went through Triage and BA Spec. ${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
