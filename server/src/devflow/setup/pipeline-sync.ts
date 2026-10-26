// What brings a company's `dev-request` pipeline in line with server/src/devflow/dev-request-pipeline.json, as plain
// data the Setup page applies through the Paperclip pipeline API. A TypeScript twin of scripts/devflow/lib/approver-sync.mjs
// (kept equal by a test that runs both on the same input): only approvers, the QA sign-off's request-changes target and
// missing transitions are ever moved; nothing is removed.

type Json = Record<string, unknown>;
export type DefinitionStage = { key: string; kind: string; config?: Json };
export type LiveStage = { id: string; key: string; kind: string; config?: Json | null };
export type DefinitionTransition = { fromStageKey: string; toStageKey: string; label?: string | null };
export type LiveTransition = { fromStageId: string; toStageId: string; label?: string | null };
export type StagePatch = { stageId: string; key: string; body: { config: Json } };
export type TransitionBody = { fromStageKey: string; toStageKey: string; label?: string };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROUTE_FIELDS: Record<string, string[]> = { qa_signoff: ["requestChangesToStageKey"] };

export function approverPatches(definitionStages: DefinitionStage[], liveStages: LiveStage[]): StagePatch[] {
  const patches: StagePatch[] = [];
  for (const wanted of definitionStages) {
    if (wanted.kind !== "review") continue;
    const live = liveStages.find((s) => s.key === wanted.key);
    if (!live || live.kind !== "review") continue;
    const approver = wanted.config?.approver;
    if (!approver) continue;
    const config = live.config ?? {};
    const next: Json = { ...config, approver };
    let routeChanged = false;
    for (const field of ROUTE_FIELDS[wanted.key] ?? []) {
      const want = wanted.config?.[field];
      if (want !== undefined && !sameJson(config[field], want)) {
        next[field] = want;
        routeChanged = true;
      }
    }
    if (sameJson(config.approver, approver) && !routeChanged) continue;
    patches.push({ stageId: live.id, key: live.key, body: { config: next } });
  }
  return patches;
}

/** The full list to PUT, or null when the company already has every edge of the definition. */
export function mergedTransitions(
  definitionTransitions: DefinitionTransition[],
  liveTransitions: LiveTransition[],
  liveStages: Array<{ id: string; key: string }>,
): TransitionBody[] | null {
  const keyOf = new Map(liveStages.map((s) => [s.id, s.key]));
  const live: TransitionBody[] = [];
  for (const t of liveTransitions) {
    const from = keyOf.get(t.fromStageId);
    const to = keyOf.get(t.toStageId);
    if (from && to) live.push({ fromStageKey: from, toStageKey: to, ...(t.label ? { label: t.label } : {}) });
  }
  const has = (from: string, to: string) => live.some((t) => t.fromStageKey === from && t.toStageKey === to);
  const stageKeys = new Set(liveStages.map((s) => s.key));
  const missing = definitionTransitions.filter((t) => stageKeys.has(t.fromStageKey) && stageKeys.has(t.toStageKey) && !has(t.fromStageKey, t.toStageKey));
  if (missing.length === 0) return null;
  return [...live, ...missing.map((t): TransitionBody => ({ fromStageKey: t.fromStageKey, toStageKey: t.toStageKey, ...(t.label ? { label: t.label } : {}) }))];
}
