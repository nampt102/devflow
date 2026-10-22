#!/usr/bin/env node
// Smoke test of the Dev stage on a running stack (change add-dev-stage, task 5.1): a real Dev agent run on the runner,
// a real branch and draft pull request on GitHub, the Code review decision, and clean-up. It costs real money (about a
// dollar) and writes to the repository you point it at, so read what it does first:
//   1. adds (or reuses) the system `smoke-dev` of the company, switches Dev on with the write token, allows an
//      unprotected default branch (the owner's decision, here the test admin's);
//   2. creates a request and seeds the approvals the earlier stages would have given (BA spec and technical plan,
//      directly in the database: those stages are covered by smoke-p1/smoke-p2), then moves it to `dev`;
//   3. waits for the worker: the agent adds one small file under docs/ on branch devflow/<key>; DevFlow pushes it and
//      opens a DRAFT pull request;
//   4. checks the pull request and the file on GitHub, the proposal in Code review, rejects it (the pull request must be
//      closed) and deletes the branch.
//
//   node scripts/devflow/smoke-p3.mjs --company <companyId> [--hold]
//
// --hold stops after step 3 and the checks of step 4: the request waits in Code review with its open draft pull request, so
// a person can look at the screen and decide there (clean up the branch afterwards).
//
// Env (docker/.env): PAPERCLIP_URL (http://localhost:3100), DEVFLOW_TEST_ADMIN_EMAIL/PASSWORD (instance admin),
// DEVFLOW_SMOKE_GITHUB_TOKEN (fine-grained token on the repository: Contents AND Pull requests, both read and write;
// DevFlow checks this before the agent runs and stops with github_forbidden when pull requests are missing),
// DEVFLOW_SMOKE_REPO (https://github.com/<owner>/<repo>), DEVFLOW_DB_CONTAINER (docker-db-1). The Dev agent and the runner
// must be set up for the company (setup-dev-runner.mjs, setup-dev-agent.mjs).
import { spawnSync } from "node:child_process";

const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const args = process.argv.slice(2);
const companyId = args[args.indexOf("--company") + 1];
const repoUrl = process.env.DEVFLOW_SMOKE_REPO ?? "https://github.com/MotivesSystem/reski_membership";
const ghToken = process.env.DEVFLOW_SMOKE_GITHUB_TOKEN;
const dbContainer = process.env.DEVFLOW_DB_CONTAINER ?? "docker-db-1";
if (!companyId || companyId.startsWith("--") || !ghToken) {
  console.error("Usage: smoke-p3.mjs --company <companyId>   (needs DEVFLOW_SMOKE_GITHUB_TOKEN)");
  process.exit(2);
}
const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repoUrl) ?? [];
if (!owner) throw new Error("DEVFLOW_SMOKE_REPO must be https://github.com/<owner>/<repo>");

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
async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "User-Agent": "devflow-smoke", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const sql = (statement) => {
  const r = spawnSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "paperclip", "-d", "paperclip", "-v", "ON_ERROR_STOP=1", "-At"], { input: statement, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};
const must = (r, what) => {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const finish = () => {
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
};

must(await call("POST", "/api/auth/sign-in/email", { email: process.env.DEVFLOW_TEST_ADMIN_EMAIL, password: process.env.DEVFLOW_TEST_ADMIN_PASSWORD }), "sign-in");

// 0. the setup the worker needs
const setup = must(await call("GET", `/api/companies/${companyId}/devflow/dev-agent`), "dev-agent setup");
check("the company has a Dev agent that DevFlow would run", setup.agent && setup.agent.problem === null, JSON.stringify(setup.agent));
if (failures) finish();

// 1. the system
const systems = must(await call("GET", `/api/companies/${companyId}/devflow/systems`), "list systems").items;
let system = systems.find((s) => s.key === "smoke-dev");
if (!system) {
  system = must(await call("POST", `/api/companies/${companyId}/devflow/systems`, { key: "smoke-dev", name: "Smoke Dev", repoUrl, defaultBranch: "main", docsPath: "docs" }), "create system");
}
system = must(await call("PATCH", `/api/companies/${companyId}/devflow/systems/${system.id}`, { writeToken: ghToken, devEnabled: true, allowUnprotected: true, active: true }), "enable Dev");
check("system has Dev on, a write token that is never shown, and the unprotected exception", system.devEnabled && system.hasWriteToken && system.allowUnprotected && !JSON.stringify(system).includes(ghToken));

// 2. the request, with the approvals of the earlier stages
const pipelines = must(await call("GET", `/api/companies/${companyId}/pipelines`), "list pipelines");
const pipeline = (Array.isArray(pipelines) ? pipelines : pipelines.pipelines).find((p) => p.key === "dev-request");
const full = must(await call("GET", `/api/pipelines/${pipeline.id}`), "read pipeline");
const stageId = (key) => full.stages.find((s) => s.key === key).id;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const created = must(await call("POST", `/api/pipelines/${pipeline.id}/cases`, { title: `Smoke P3 ${stamp}`, fields: {} }), "create case");
const caseRow = created.case ?? created;
const caseId = caseRow.id;
const caseKey = caseRow.caseKey ?? caseRow.case_key;
const spec = {
  summary: "Thêm một tệp ghi chú nhỏ vào docs để kiểm tra agent Dev.",
  businessGoal: "Kiểm tra luồng Dev từ đầu đến cuối.",
  inScope: ["Một tệp docs/devflow-smoke.md"],
  outOfScope: ["Mọi mã ứng dụng"],
  userStories: [{ asA: "nhân viên", iWant: "thấy PR nháp của agent", soThat: "tôi duyệt được" }],
  acceptanceCriteria: ["Có tệp docs/devflow-smoke.md với đúng một dòng"],
  affectedAreas: [],
  dataChanges: [],
  risks: [],
  openQuestions: [],
  confidence: "high",
};
const marker = `DevFlow Dev smoke test ${stamp}`;
const plan = {
  summary: "Tạo tệp docs/devflow-smoke.md.",
  approach: "Chỉ thêm một tệp văn bản mới trong thư mục docs; không đổi mã.",
  tasks: [
    {
      id: "T1",
      title: "Tạo docs/devflow-smoke.md",
      system: "smoke-dev",
      description: `Tạo tệp docs/devflow-smoke.md chứa đúng một dòng: ${marker}. Không sửa tệp nào khác. Commit bằng một commit.`,
      size: "S",
      files: [{ path: "docs/devflow-smoke.md", line: null, change: "tệp mới" }],
      dependsOn: [],
    },
  ],
  dataChanges: [],
  apiChanges: [],
  testPlan: ["Mở tệp và kiểm tra có đúng một dòng"],
  risks: [],
  openQuestions: [],
  confidence: "high",
};
const j = (v) => `$j$${JSON.stringify(v)}$j$::jsonb`;
const seeded = sql(`
begin;
update dr_request_counters set last_number = last_number + 1, updated_at = now() where company_id = '${companyId}';
update pipeline_cases set case_key = 'SMK-' || (select last_number from dr_request_counters where company_id = '${companyId}') where id = '${caseId}';
with n as (select last_number as n from dr_request_counters where company_id = '${companyId}'),
     r as (select id, user_id from dr_requesters where company_id = '${companyId}' limit 1)
insert into dr_requests (case_id, company_id, request_number, requester_id, description, classification, priority, difficulty)
select '${caseId}', '${companyId}', n.n, r.id, 'Smoke test của stage Dev: chỉ thêm một tệp ghi chú vào docs.', 'feature', 'low', 'easy' from n, r;
insert into dr_agent_outputs (company_id, case_id, stage_key, prompt_role, prompt_version, prompt_hash, status, decided_at, decided_by_user_id, data, comment_text)
select '${companyId}', '${caseId}', 'ba_spec', 'ba', 'v1', 'smoke', 'accepted', now(), r.user_id, jsonb_build_object('approved', ${j(spec)}), 'smoke' from dr_requesters r where r.company_id = '${companyId}' limit 1;
insert into dr_agent_outputs (company_id, case_id, stage_key, prompt_role, prompt_version, prompt_hash, status, decided_at, decided_by_user_id, data, comment_text)
select '${companyId}', '${caseId}', 'tech_plan', 'plan', 'v1', 'smoke', 'accepted', now(), r.user_id, jsonb_build_object('approved', ${j(plan)}), 'smoke' from dr_requesters r where r.company_id = '${companyId}' limit 1;
insert into dr_request_systems (company_id, case_id, system_id) values ('${companyId}', '${caseId}', '${system.id}');
update pipeline_cases set stage_id = '${stageId("dev")}', version = version + 1, updated_at = now() where id = '${caseId}';
commit;
select 'seeded';`);
check("request seeded at stage dev", seeded.includes("seeded"));
console.log(`request ${caseKey} (${caseId}) waits at stage dev; the worker runs the agent now (up to an hour; usually a few minutes)`);

// 3. the worker
const stageOf = async () => {
  const c = must(await call("GET", `/api/cases/${caseId}`), "read case");
  const row = c.case ?? c;
  return full.stages.find((s) => s.id === row.stageId)?.key;
};
const deadline = Date.now() + 40 * 60_000;
let stage = "dev";
while (Date.now() < deadline && stage === "dev") {
  await sleep(15_000);
  stage = await stageOf();
  const failed = sql(`select details->>'kind' from activity_log where company_id='${companyId}' and entity_id='${caseId}' and action in ('agent.dev_failed','agent.dev_gave_up') order by created_at desc limit 1;`);
  if (failed) console.log(`  worker reported: ${failed}`);
  if (failed && /^(repo_unprotected|github_|write_token|agent_|runner_|no_)/.test(failed)) break;
}
check("the worker sent the request to code_review", stage === "code_review", `stage ${stage}`);
if (stage !== "code_review") finish();

// 4. what was produced
const detail = must(await call("GET", `/api/companies/${companyId}/devflow/code-cases/${caseId}`), "code review detail");
const repoResult = detail.repos[0];
check("a draft pull request was opened by DevFlow", Boolean(repoResult?.prUrl) && repoResult.prNumber > 0, JSON.stringify(repoResult));
check("the default branch warning is shown (the branch is unprotected)", repoResult?.unprotectedWarning === true);
check("the report names the task and no more", detail.report.tasks.length === 1 && detail.report.tasks[0].id === "T1");
check("the proposal can be approved", detail.approveBlocker === null);
console.log(`  PR: ${repoResult?.prUrl}   cost: ${detail.costUsd} USD   model: ${detail.model}`);
console.log(`  agent said: ${detail.report.summary}`);

const branch = repoResult.branch;
const pr = await gh("GET", `/repos/${owner}/${repo}/pulls/${repoResult.prNumber}`);
check("on GitHub the pull request is open and a draft, from devflow/* to main", pr.body.state === "open" && pr.body.draft === true && pr.body.head.ref === branch && pr.body.base.ref === "main" && branch.startsWith("devflow/"), JSON.stringify({ state: pr.body.state, draft: pr.body.draft, head: pr.body.head?.ref }));
const file = await gh("GET", `/repos/${owner}/${repo}/contents/docs/devflow-smoke.md?ref=${encodeURIComponent(branch)}`);
const content = file.status === 200 ? Buffer.from(file.body.content, "base64").toString("utf8") : "";
check("the file the plan asked for is on the branch", content.includes(marker), `status ${file.status}`);
const compare = await gh("GET", `/repos/${owner}/${repo}/compare/main...${encodeURIComponent(branch)}`);
check("the branch changes only that file", compare.status === 200 && compare.body.files?.length === 1 && compare.body.files[0].filename === "docs/devflow-smoke.md", JSON.stringify(compare.body.files?.map((f) => f.filename)));
const main = await gh("GET", `/repos/${owner}/${repo}/branches/main`);
check("main was not touched by DevFlow (no push to it)", main.body?.commit?.sha === compare.body?.merge_base_commit?.sha);

// With --hold the request stays in Code review (and the draft pull request open) for a person to decide in the browser.
if (args.includes("--hold")) {
  console.log(`held: open Code review for ${caseKey} and decide there; afterwards delete the branch: DELETE /repos/${owner}/${repo}/git/refs/heads/${branch}`);
  finish();
}

// 5. the decision and clean-up
const decision = await call("POST", `/api/companies/${companyId}/devflow/code-cases/${caseId}/decision`, { outputId: detail.outputId, expectedVersion: detail.version, decision: "reject", reason: "smoke test finished" });
check("reject accepted", decision.status === 200, JSON.stringify(decision.body));
check("DevFlow reported the pull request closed", decision.body?.closedPullRequests?.[0]?.closed === true, JSON.stringify(decision.body));
const closed = await gh("GET", `/repos/${owner}/${repo}/pulls/${repoResult.prNumber}`);
check("on GitHub the pull request is closed and not merged", closed.body.state === "closed" && closed.body.merged === false);
check("the request is cancelled", (await stageOf()) === "cancelled");
const del = await gh("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
check("the smoke branch was deleted", del.status === 204, `status ${del.status}`);
finish();
