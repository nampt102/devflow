// Pure part of the request history (openspec change add-request-history): turns rows from the four sources into one
// timeline, newest first. No address, token, prompt text or transcript ever enters it (design D2).

export type Raw = {
  events: Array<{ type: string; at: Date | string; actorName: string | null; actorType: string; fromStage: string | null; toStage: string | null; payload: Record<string, unknown> }>;
  overrides: Array<{ at: Date | string; field: string; agentValue: unknown; finalValue: unknown; actorName: string | null; reason: string | null; stageKey: string }>;
  outputs: Array<{ at: Date | string; stageKey: string; role: string; promptVersion: string; status: string; data: Record<string, unknown> }>;
  runs: Array<{ at: Date | string; action: string; details: Record<string, unknown> | null }>;
  emails: Array<{ at: Date | string; subject: string; status: string; error: string | null }>;
};

export type HistoryItem = {
  at: string;
  kind: "submitted" | "stage" | "decision" | "field_change" | "proposal" | "agent_run" | "agent_failed" | "email";
  actor: string | null;
  summary: string;
  details: Record<string, string | number | boolean | null>;
};

const iso = (d: Date | string) => new Date(d).toISOString();
const ROLE_LABEL: Record<string, string> = { triage: "Triage", ba: "BA", plan: "Planner", dev: "Dev", qa: "QA" };
const roleOf = (action: string) => /^agent\.([a-z]+)_/.exec(action)?.[1] ?? "agent";
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r;
const DECISION_TEXT: Record<string, string> = { approve: "Approved", reject: "Rejected", request_changes: "Sent back for changes" };

/** One short line for a stored value: text as is, lists joined, anything else as short JSON. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 117)}...` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "none" : valueText(v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", "));
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

type Repo = { system?: unknown; prUrl?: unknown; prNumber?: unknown };
/** Links to pull requests an output holds (Dev's repos, QA's tested repos): a number and a URL, nothing else. */
function pullRequests(data: Record<string, unknown>): Array<{ system: string; number: number; url: string }> {
  const repos = Array.isArray(data.repos) ? (data.repos as Repo[]) : [];
  return repos
    .filter((r) => typeof r.prUrl === "string" && typeof r.prNumber === "number")
    .map((r) => ({ system: String(r.system ?? ""), number: r.prNumber as number, url: r.prUrl as string }));
}

export function buildHistory(raw: Raw, limit = 200): { items: HistoryItem[]; costUsd: number; stages: Array<{ name: string; enteredAt: string; leftAt: string | null }> } {
  const items: HistoryItem[] = [];

  for (const e of raw.events) {
    if (e.type === "ingested") {
      items.push({ at: iso(e.at), kind: "submitted", actor: e.actorName, summary: "Request submitted", details: {} });
    } else if (e.type === "transitioned") {
      items.push({ at: iso(e.at), kind: "stage", actor: e.actorName, summary: `Moved ${e.fromStage ? `from ${e.fromStage} ` : ""}to ${e.toStage ?? "another stage"}`, details: {} });
    } else if (e.type === "review_decided") {
      const decision = String(e.payload.decision ?? "");
      const reason = typeof e.payload.reason === "string" && e.payload.reason ? e.payload.reason : null;
      items.push({ at: iso(e.at), kind: "decision", actor: e.actorName, summary: `${DECISION_TEXT[decision] ?? decision}${e.fromStage ? ` at ${e.fromStage}` : ""}`, details: { decision, reason } });
    }
  }

  for (const o of raw.overrides) {
    items.push({
      at: iso(o.at),
      kind: "field_change",
      actor: o.actorName,
      summary: `${o.field}: ${valueText(o.agentValue)} → ${valueText(o.finalValue)}`,
      details: { field: o.field, stage: o.stageKey, agentValue: valueText(o.agentValue), finalValue: valueText(o.finalValue), reason: o.reason },
    });
  }

  for (const o of raw.outputs) {
    const prs = pullRequests(o.data);
    const details: HistoryItem["details"] = { role: o.role, promptVersion: o.promptVersion, status: o.status };
    prs.forEach((p, i) => {
      details[`pullRequest${i + 1}`] = `${p.system} #${p.number}`;
      details[`pullRequest${i + 1}Url`] = p.url;
    });
    items.push({ at: iso(o.at), kind: "proposal", actor: null, summary: `${roleLabel(o.role)} proposal (${o.status})`, details });
  }

  let costUsd = 0;
  for (const r of raw.runs) {
    const role = roleOf(r.action);
    const d = r.details ?? {};
    if (r.action.endsWith("_run")) {
      const cost = typeof d.costUsd === "number" ? d.costUsd : Number(d.costUsd) || 0;
      costUsd += cost;
      const ok = d.ok === true;
      items.push({
        at: iso(r.at),
        kind: "agent_run",
        actor: null,
        summary: `${roleLabel(role)} agent ran: ${ok ? "ok" : `failed${d.kind ? ` (${String(d.kind)})` : ""}`}`,
        details: { role, ok, kind: typeof d.kind === "string" ? d.kind : null, costUsd: Math.round(cost * 10000) / 10000, promptVersion: typeof d.promptVersion === "string" ? d.promptVersion : null },
      });
    } else if (r.action.endsWith("_failed") || r.action.endsWith("_gave_up") || r.action.endsWith("_budget_paused")) {
      const what = r.action.endsWith("_gave_up") ? "gave up" : r.action.endsWith("_budget_paused") ? "paused (daily spend cap)" : "failed";
      items.push({ at: iso(r.at), kind: "agent_failed", actor: null, summary: `${roleLabel(role)} agent ${what}${d.kind ? `: ${String(d.kind)}` : ""}`, details: { role, kind: typeof d.kind === "string" ? d.kind : null } });
    }
  }

  for (const m of raw.emails) {
    items.push({ at: iso(m.at), kind: "email", actor: null, summary: `Email to the requester: ${m.subject}`, details: { status: m.status, error: m.error } });
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // time in each stage: from the moment it was entered to the next move
  const moves = raw.events
    .filter((e) => (e.type === "ingested" || e.type === "transitioned") && e.toStage)
    .map((e) => ({ name: e.toStage as string, at: iso(e.at) }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const stages = moves.map((m, i) => ({ name: m.name, enteredAt: m.at, leftAt: moves[i + 1]?.at ?? null }));

  return { items: items.slice(0, limit), costUsd: Math.round(costUsd * 10000) / 10000, stages };
}
