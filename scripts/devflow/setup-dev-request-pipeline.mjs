#!/usr/bin/env node
// Seeds the DevFlow `dev-request` pipeline into a company and (with --verify) checks the gates against
// a running instance. Definition: server/src/devflow/dev-request-pipeline.json
//
//   node scripts/devflow/setup-dev-request-pipeline.mjs --company <companyId> [--verify]
//
// Env: PAPERCLIP_URL (default http://localhost:3100), DEVFLOW_TEST_ADMIN_EMAIL, DEVFLOW_TEST_ADMIN_PASSWORD
// (board user; local test accounts only). Idempotent: an existing `dev-request` pipeline is kept, and only the
// review stages' `approver` is brought in line with the definition (roles; add-approver-roles), the QA sign-off's
// request-changes target and any transition the definition has and the company lacks are added (add-qa-stage). `--any-human`
// rolls every review stage back to any_human. With --verify the account must be allowed to decide (company owner
// or hold the roles), because the walk approves through the core API.
import { readFileSync } from "node:fs";
import { approverPatches, mergedTransitions } from "./lib/approver-sync.mjs";

const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const args = process.argv.slice(2);
const companyId = args[args.indexOf("--company") + 1];
const verify = args.includes("--verify");
const anyHuman = args.includes("--any-human");
if (!companyId || companyId.startsWith("--")) {
  console.error("Usage: setup-dev-request-pipeline.mjs --company <companyId> [--verify] [--any-human]");
  process.exit(1);
}
const definition = JSON.parse(
  readFileSync(new URL("../../server/src/devflow/dev-request-pipeline.json", import.meta.url), "utf8"),
);

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const login = await call("POST", "/api/auth/sign-in/email", {
  email: process.env.DEVFLOW_TEST_ADMIN_EMAIL,
  password: process.env.DEVFLOW_TEST_ADMIN_PASSWORD,
});
if (login.status !== 200) throw new Error(`sign-in failed: ${login.status}`);

const list = await call("GET", `/api/companies/${companyId}/pipelines`);
const existing = (Array.isArray(list.body) ? list.body : list.body?.pipelines ?? []).find((p) => p.key === definition.key);
let pipelineId = existing?.id;
if (pipelineId) {
  console.log(`pipeline ${definition.key} already exists (${pipelineId})`);
} else {
  const { transitions, ...create } = definition;
  const created = await call("POST", `/api/companies/${companyId}/pipelines`, { ...create, enforceTransitions: false });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  pipelineId = created.body.id;
  const put = await call("PUT", `/api/pipelines/${pipelineId}/transitions`, { transitions, enforceTransitions: true });
  if (put.status !== 200) throw new Error(`transitions failed: ${put.status} ${JSON.stringify(put.body)}`);
  console.log(`seeded pipeline ${definition.key} (${pipelineId})`);
}

// Stage config is stored per company, so an already-seeded pipeline keeps its old approvers until we update them
// here. Only `config.approver` changes (see lib/approver-sync.mjs); running again changes nothing.
{
  const live = await call("GET", `/api/pipelines/${pipelineId}`);
  if (live.status !== 200) throw new Error(`cannot read pipeline: ${live.status}`);
  const patches = approverPatches(definition.stages, live.body.stages ?? [], { anyHuman });
  for (const p of patches) {
    const done = await call("PATCH", `/api/pipelines/${pipelineId}/stages/${p.stageId}`, p.body);
    if (done.status !== 200) throw new Error(`approver update failed for ${p.key}: ${done.status} ${JSON.stringify(done.body)}`);
    console.log(`stage ${p.key}: approver set to ${JSON.stringify(p.body.config.approver)}`);
  }
  if (!patches.length) console.log("review approvers already up to date");
  // the transitions the definition has and the company lacks (add-qa-stage: qa_signoff -> dev); nothing is removed
  const merged = anyHuman ? null : mergedTransitions(definition.transitions, live.body.transitions ?? [], live.body.stages ?? []);
  if (merged) {
    const put = await call("PUT", `/api/pipelines/${pipelineId}/transitions`, { transitions: merged, enforceTransitions: live.body.enforceTransitions !== false });
    if (put.status !== 200) throw new Error(`transitions update failed: ${put.status} ${JSON.stringify(put.body)}`);
    console.log(`transitions: added ${merged.length - (live.body.transitions ?? []).length} missing`);
  } else {
    console.log("transitions already up to date");
  }
}
if (!verify) process.exit(0);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
};
const unwrap = (r) => r.body?.case ?? r.body;
const created = await call("POST", `/api/pipelines/${pipelineId}/cases`, { title: `verify ${Date.now()}`, fields: {} });
let c = unwrap(created);
check("case created", created.status === 201, JSON.stringify(created.body).slice(0, 200));
const stageOf = async () => {
  const r = await call("GET", `/api/cases/${c.id}`);
  c = unwrap(r);
  return c;
};
const pipe = await call("GET", `/api/pipelines/${pipelineId}`);
const stageKeyById = Object.fromEntries((pipe.body.stages ?? []).map((s) => [s.id, s.key]));
const at = async () => stageKeyById[(await stageOf()).stageId];

check("starts at triage", (await at()) === "triage");
let r = await call("POST", `/api/cases/${c.id}/transition`, { toStageKey: "dev", expectedVersion: c.version });
check("cannot skip stages (triage -> dev rejected)", r.status >= 400 && r.status < 500, `status ${r.status}`);
r = await call("POST", `/api/cases/${c.id}/transition`, { toStageKey: "triage_review", expectedVersion: (await stageOf()).version });
check("triage -> triage_review allowed", r.status === 200, `status ${r.status}`);
r = await call("POST", `/api/cases/${c.id}/review`, { decision: "reject", expectedVersion: (await stageOf()).version });
check("reject without reason refused", r.status >= 400 && r.status < 500, `status ${r.status}`);
r = await call("POST", `/api/cases/${c.id}/review`, { decision: "request_changes", reason: "need more detail", expectedVersion: (await stageOf()).version });
check("request_changes returns to triage", r.status === 200 && (await at()) === "triage", `status ${r.status}`);
await call("POST", `/api/cases/${c.id}/transition`, { toStageKey: "triage_review", expectedVersion: (await stageOf()).version });
r = await call("POST", `/api/cases/${c.id}/review`, { decision: "approve", expectedVersion: (await stageOf()).version });
check("approve advances to ba_spec", r.status === 200 && (await at()) === "ba_spec", `status ${r.status}`);
const ev = await call("GET", `/api/cases/${c.id}/events`);
const events = Array.isArray(ev.body) ? ev.body : ev.body?.items ?? [];
check("events recorded for the walk", events.length >= 4, `status ${ev.status} body ${JSON.stringify(ev.body).slice(0, 200)}`);
console.log(`event types: ${events.map((e) => e.type).join(", ")}`);
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
