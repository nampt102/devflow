// Pure part of setup-dev-request-pipeline.mjs: which stage PATCHes bring an already-seeded pipeline's review
// approvers in line with the definition (openspec change add-approver-roles, D7).
//
// Stage config lives in the database per company, so editing dev-request-pipeline.json only affects companies
// seeded afterwards. This compares the live review stages with the definition and returns one PATCH body per stage
// that differs. Only `config.approver` changes; every other field of the live config is copied through, because
// the stage PATCH replaces the whole config.

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
    if (sameJson(config.approver, approver)) continue;
    patches.push({ stageId: live.id, key: live.key, body: { config: { ...config, approver } } });
  }
  return patches;
}
