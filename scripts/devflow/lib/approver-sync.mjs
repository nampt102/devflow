// Pure part of setup-dev-request-pipeline.mjs: which stage PATCHes bring an already-seeded pipeline's review
// approvers in line with the definition (openspec change add-approver-roles, D7).
//
// Stage config lives in the database per company, so editing dev-request-pipeline.json only affects companies
// seeded afterwards. This compares the live review stages with the definition and returns one PATCH body per stage
// that differs. Only `config.approver` changes; every other field of the live config is copied through, because
// the stage PATCH replaces the whole config.

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The only stage settings besides `approver` this sync may move, by stage key (openspec change add-qa-stage): a QA
 * sign-off that asks for changes goes back to Dev, not to QA. Everything else in a live config stays as the company has it.
 */
const ROUTE_FIELDS = { qa_signoff: ["requestChangesToStageKey"] };

/**
 * @param {Array<{ key: string, kind: string, config?: { approver?: unknown } }>} definitionStages
 * @param {Array<{ id: string, key: string, kind: string, config?: Record<string, unknown> | null }>} liveStages
 * @param {{ anyHuman?: boolean }} [options] anyHuman: roll back, every review stage returns to any_human
 * @returns {Array<{ stageId: string, key: string, body: { config: Record<string, unknown> } }>}
 */
export function approverPatches(definitionStages, liveStages, options = {}) {
  const patches = [];
  for (const wanted of definitionStages) {
    if (wanted.kind !== "review") continue;
    const live = liveStages.find((s) => s.key === wanted.key);
    if (!live || live.kind !== "review") continue;
    const approver = options.anyHuman ? { kind: "any_human" } : wanted.config?.approver;
    if (!approver) continue;
    const config = live.config ?? {};
    const next = { ...config, approver };
    let routeChanged = false;
    for (const field of ROUTE_FIELDS[wanted.key] ?? []) {
      const want = wanted.config?.[field];
      if (!options.anyHuman && want !== undefined && !sameJson(config[field], want)) {
        next[field] = want;
        routeChanged = true;
      }
    }
    if (sameJson(config.approver, approver) && !routeChanged) continue;
    patches.push({ stageId: live.id, key: live.key, body: { config: next } });
  }
  return patches;
}

/**
 * The full transition list to send to PUT /pipelines/:id/transitions, or null when the company already has every edge of the
 * definition. Only adds: an edge the company has and the definition does not (for example the old `qa_signoff -> qa`) stays.
 *
 * @param {Array<{ fromStageKey: string, toStageKey: string, label?: string | null }>} definitionTransitions
 * @param {Array<{ fromStageId: string, toStageId: string, label?: string | null }>} liveTransitions
 * @param {Array<{ id: string, key: string }>} liveStages
 * @returns {Array<{ fromStageKey: string, toStageKey: string, label?: string }> | null}
 */
export function mergedTransitions(definitionTransitions, liveTransitions, liveStages) {
  const keyOf = new Map(liveStages.map((s) => [s.id, s.key]));
  const live = [];
  for (const t of liveTransitions) {
    const from = keyOf.get(t.fromStageId);
    const to = keyOf.get(t.toStageId);
    if (from && to) live.push({ fromStageKey: from, toStageKey: to, ...(t.label ? { label: t.label } : {}) });
  }
  const has = (from, to) => live.some((t) => t.fromStageKey === from && t.toStageKey === to);
  const stageKeys = new Set(liveStages.map((s) => s.key));
  const missing = definitionTransitions.filter((t) => stageKeys.has(t.fromStageKey) && stageKeys.has(t.toStageKey) && !has(t.fromStageKey, t.toStageKey));
  if (missing.length === 0) return null;
  return [...live, ...missing.map((t) => ({ fromStageKey: t.fromStageKey, toStageKey: t.toStageKey, ...(t.label ? { label: t.label } : {}) }))];
}
