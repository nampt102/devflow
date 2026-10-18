#!/usr/bin/env node
// P1 acceptance smoke test against a running DevFlow instance: a requester files a request in the portal,
// Triage proposes, a staff member corrects and approves it, and the requester sees the new status.
//
//   node scripts/devflow/smoke-p1.mjs [--wait 180]
//
// Env (local test accounts only; see docker/.env.example):
//   PAPERCLIP_URL                         default http://localhost:3100
//   DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD     a board user with access to the company (staff)
//   DEVFLOW_TEST_PORTAL_EMAIL/PASSWORD    a requester of the same company (not the staff user)
// It creates one real request ("Smoke test <time>") and approves it, so run it on a test or pilot-staging
// company. It needs the Triage worker configured (DEVFLOW_LLM_*); without it the wait for a proposal fails.
// Each sign-in waits 11 s because better-auth limits sign-ins per address.
const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const args = process.argv.slice(2);
const waitSeconds = Number(args[args.indexOf("--wait") + 1]) || 180;
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
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

const metricsUrl = `/api/companies/${companyId}/devflow/triage-metrics?days=1`;
r = await staff("GET", metricsUrl);
if (!check("staff can read the metrics", r.status === 200, r.status)) abort("staff has no access to the company, or the triage API is missing");
const before = r.body.approved.total;

// the requester must not reach the staff API
r = await requester("GET", `/api/companies/${companyId}/devflow/triage-queue`);
check("requester cannot read the staff queue", r.status === 403 || r.status === 404, r.status);

const title = `Smoke test ${new Date().toISOString().slice(0, 19)}`;
r = await requester("POST", "/api/portal/requests", { title, description: "Thêm cột ngày giao vào báo cáo đơn hàng. (kiểm tra tự động, có thể bỏ qua)" });
if (!check("requester files a request", r.status === 201 && Number.isInteger(r.body?.number), `${r.status} ${JSON.stringify(r.body)}`)) abort("submit failed");
const number = r.body.number;
check("requester sees it as received", r.body.statusLabel === "Đã tiếp nhận", r.body.statusLabel);

// wait for Triage to propose
let item = null;
const deadline = Date.now() + waitSeconds * 1000;
while (Date.now() < deadline) {
  r = await staff("GET", `/api/companies/${companyId}/devflow/triage-queue`);
  item = r.body?.items?.find((i) => i.requestNumber === number) ?? null;
  if (item) break;
  await sleep(5000);
}
if (!check(`Triage proposes within ${waitSeconds}s`, !!item, "no proposal: is the Triage worker configured (DEVFLOW_LLM_*), DEVFLOW_WORKERS_ENABLED not false, and the daily token cap not reached?")) abort("no proposal");
const p = item.proposal;
check("proposal has valid fields", ["bug", "feature", "request"].includes(p.classification) && ["urgent", "high", "medium", "low"].includes(p.priority) && ["easy", "medium", "hard"].includes(p.difficulty), JSON.stringify(p));
r = await requester("GET", `/api/portal/requests/${number}`);
check("requester sees the waiting-for-review status", r.body?.statusLabel === "Đang chờ duyệt phân loại", r.body?.statusLabel);
check("requester view hides the proposal", !JSON.stringify(r.body).includes(item.outputId) && !("proposal" in (r.body ?? {})), "proposal leaked into the portal DTO");

r = await staff("GET", `/api/companies/${companyId}/devflow/triage-cases/${item.caseId}`);
check("staff opens the detail", r.status === 200 && r.body.outputId === item.outputId, r.status);
const detail = r.body;

// approve with one correction (a different priority), so an override is recorded
const newPriority = detail.proposal.priority === "high" ? "low" : "high";
r = await staff("POST", `/api/companies/${companyId}/devflow/triage-cases/${item.caseId}/decision`, {
  outputId: detail.outputId,
  expectedVersion: detail.version,
  decision: "approve",
  // duplicateOfCaseId null: the agent may name an earlier similar request as a duplicate (the sample text resembles
  // earlier ones); approving needs the reviewer to say it is not one
  final: { priority: newPriority, duplicateOfCaseId: null },
});
check("staff approves with a correction", r.status === 200 && r.body.overriddenFields?.includes("priority"), `${r.status} ${JSON.stringify(r.body)}`);
r = await staff("POST", `/api/companies/${companyId}/devflow/triage-cases/${item.caseId}/decision`, {
  outputId: detail.outputId,
  expectedVersion: detail.version,
  decision: "approve",
  final: { duplicateOfCaseId: null },
});
check("a second decision on the same proposal is refused", r.status === 409 || r.status === 404, r.status);

r = await requester("GET", `/api/portal/requests/${number}`);
check("requester sees the next status", r.body?.statusLabel === "Đang phân tích nghiệp vụ", r.body?.statusLabel);

r = await staff("GET", metricsUrl);
check("metrics count the approval", r.status === 200 && r.body.approved.total === before + 1, `before=${before} after=${r.body?.approved?.total}`);
check("metrics count the correction", (r.body?.fields?.find((f) => f.field === "priority")?.overrides ?? 0) >= 1, JSON.stringify(r.body?.fields));

console.log(`\nREQ ${number} ("${title}") was created and approved. ${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
