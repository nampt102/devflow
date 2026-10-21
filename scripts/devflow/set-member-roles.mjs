#!/usr/bin/env node
// Sets the business roles (ba, tech_lead) of one staff member of a company. A person can have both.
// The list you pass REPLACES the person's roles, so `--roles ba` removes tech_lead if they had it.
//
//   node scripts/devflow/set-member-roles.mjs --company <companyId> --email <email> --roles ba,tech_lead
//   node scripts/devflow/set-member-roles.mjs --company <companyId> --email <email> --roles none     (remove all)
//   node scripts/devflow/set-member-roles.mjs --company <companyId> --list                           (show everyone)
//
// Env: PAPERCLIP_URL (default http://localhost:3100), DEVFLOW_TEST_ADMIN_EMAIL, DEVFLOW_TEST_ADMIN_PASSWORD
// (the account must be the company owner or an instance admin). Safe to run again.
const base = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const companyId = arg("--company");
const email = arg("--email");
const rolesArg = arg("--roles");
const listOnly = args.includes("--list");
if (!companyId || companyId.startsWith("--") || (!listOnly && (!email || rolesArg === undefined))) {
  console.error("Usage: set-member-roles.mjs --company <companyId> (--list | --email <email> --roles ba,tech_lead|none)");
  process.exit(2);
}

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
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const login = await call("POST", "/api/auth/sign-in/email", {
  email: process.env.DEVFLOW_TEST_ADMIN_EMAIL,
  password: process.env.DEVFLOW_TEST_ADMIN_PASSWORD,
});
if (login.status !== 200) throw new Error(`sign-in failed: ${login.status}`);

const list = await call("GET", `/api/companies/${companyId}/devflow/member-roles`);
if (list.status !== 200) throw new Error(`cannot read roles: ${list.status} ${JSON.stringify(list.body)}`);
const show = (m) => `${m.email.padEnd(36)} ${(m.membershipRole ?? "-").padEnd(8)} ${m.roles.join(", ") || "(no roles)"}${m.alwaysApproves ? "  [owner: approves everything]" : ""}`;

if (listOnly) {
  for (const m of list.body.items) console.log(show(m));
  process.exit(0);
}

const member = list.body.items.find((m) => m.email.toLowerCase() === email.toLowerCase());
if (!member) {
  console.error(`No active member with email ${email} in this company. Known: ${list.body.items.map((m) => m.email).join(", ")}`);
  process.exit(1);
}
const roles = rolesArg === "none" || rolesArg === "" ? [] : rolesArg.split(",").map((r) => r.trim()).filter(Boolean);
const put = await call("PUT", `/api/companies/${companyId}/devflow/member-roles/${member.userId}`, { roles });
if (put.status !== 200) {
  console.error(`failed: ${put.status} ${JSON.stringify(put.body)}`);
  process.exit(1);
}
console.log(`${member.email}: ${put.body.roles.join(", ") || "(no roles)"}${put.body.changed ? "" : "  (no change)"}`);
