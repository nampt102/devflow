import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPipelineSchema, replaceTransitionsSchema } from "../routes/pipelines-schemas.ts";

// DevFlow seed definition (openspec/decisions/0003). Pure checks of the stage graph and gate
// configuration; runtime behavior is covered by scripts/devflow/setup-dev-request-pipeline.mjs --verify.
const definition = JSON.parse(
  readFileSync(new URL("../devflow/dev-request-pipeline.json", import.meta.url), "utf8"),
) as {
  key: string;
  enforceTransitions: boolean;
  stages: Array<{ key: string; kind: string; position: number; config?: Record<string, any> }>;
  transitions: Array<{ fromStageKey: string; toStageKey: string }>;
};

// add-approver-roles and add-dev-stage: the stages that have an agent need a role (code review: Tech Lead; QA sign-off: QA or Tech Lead).
const EXPECTED_APPROVER: Record<string, unknown> = {
  triage_review: { kind: "role", roles: ["ba", "tech_lead"] },
  ba_review: { kind: "role", roles: ["ba", "tech_lead"] },
  plan_review: { kind: "role", roles: ["tech_lead"] },
  code_review: { kind: "role", roles: ["tech_lead"] },
  qa_signoff: { kind: "role", roles: ["qa", "tech_lead"] },
};

const stages = definition.stages;
const byKey = new Map(stages.map((s) => [s.key, s]));
const reviews = stages.filter((s) => s.kind === "review");
const edges = definition.transitions.map((t) => `${t.fromStageKey}>${t.toStageKey}`);

describe("dev-request pipeline definition", () => {
  it("is accepted by the real API schemas", () => {
    expect(createPipelineSchema.safeParse(definition).success).toBe(true);
    expect(replaceTransitionsSchema.safeParse({ transitions: definition.transitions }).success).toBe(true);
  });

  it("has unique keys, increasing positions and exactly one done and one cancelled stage", () => {
    expect(byKey.size).toBe(stages.length);
    stages.slice(1).forEach((s, i) => expect(s.position).toBeGreaterThan(stages[i].position));
    expect(stages.filter((s) => s.kind === "done")).toHaveLength(1);
    expect(stages.filter((s) => s.kind === "cancelled")).toHaveLength(1);
  });

  it("enforces transitions and has no edge to or from an unknown stage", () => {
    expect(definition.enforceTransitions).toBe(true);
    for (const t of definition.transitions) {
      expect(byKey.has(t.fromStageKey)).toBe(true);
      expect(byKey.has(t.toStageKey)).toBe(true);
    }
  });

  it("puts a human review gate after every working stage", () => {
    const working = stages.filter((s) => s.kind === "working");
    expect(working.map((s) => s.key)).toEqual(["triage", "ba_spec", "tech_plan", "dev", "qa"]);
    expect(reviews).toHaveLength(working.length);
    for (const w of working) {
      const out = definition.transitions.filter((t) => t.fromStageKey === w.key);
      // the only way out of a working stage is into a review stage: no skipping a gate
      expect(out).toHaveLength(1);
      expect(byKey.get(out[0].toStageKey)?.kind).toBe("review");
    }
  });

  it("configures every review stage as human-only with reasons required", () => {
    for (const r of reviews) {
      const c = r.config!;
      expect(c.requireApproval).toBe(true);
      expect(c.approver).toEqual(EXPECTED_APPROVER[r.key]); // never an agent approver
      expect(c.requireRejectReason).toBe(true);
      expect(c.requireRequestChangesReason).toBe(true);
      expect(byKey.get(c.rejectToStageKey)?.kind).toBe("cancelled");
      expect(byKey.get(c.requestChangesToStageKey)?.kind).toBe("working");
    }
  });

  it("lists every review stage in the approver table, so a new stage cannot skip the role decision", () => {
    expect(reviews.map((r) => r.key).sort()).toEqual(Object.keys(EXPECTED_APPROVER).sort());
  });

  it("matches review exits to declared transitions and only approval advances", () => {
    for (const r of reviews) {
      const c = r.config!;
      for (const target of [c.approveToStageKey, c.rejectToStageKey, c.requestChangesToStageKey]) {
        expect(edges).toContain(`${r.key}>${target}`);
      }
      // a review stage has exactly approve / reject / request-changes exits
      expect(definition.transitions.filter((t) => t.fromStageKey === r.key)).toHaveLength(3);
    }
  });

  it("reaches done only through the QA sign-off and every stage can reach a terminal stage", () => {
    const intoDone = definition.transitions.filter((t) => t.toStageKey === "done");
    expect(intoDone.map((t) => t.fromStageKey)).toEqual(["qa_signoff"]);
    const next = (k: string) => definition.transitions.filter((t) => t.fromStageKey === k).map((t) => t.toStageKey);
    for (const s of stages.filter((x) => x.kind === "working" || x.kind === "review")) {
      const seen = new Set<string>([s.key]);
      const queue = [s.key];
      while (queue.length) for (const n of next(queue.shift()!)) if (!seen.has(n)) (seen.add(n), queue.push(n));
      expect(seen.has("done")).toBe(true);
    }
  });

  it("is linear: approving each gate moves exactly one step forward", () => {
    const order = ["triage", "ba_spec", "tech_plan", "dev", "qa", "done"];
    reviews.forEach((r, i) => expect(r.config!.approveToStageKey).toBe(order[i + 1]));
  });
});
