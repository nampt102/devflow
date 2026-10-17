import { describe, expect, it } from "vitest";
import type { TriageDetail, TriageQueueItem } from "../api/devflowTriage";
import { ageLabel, changedFields, decisionBlocker, draftFromDetail, filterQueue, finalPatch, scoreLabel } from "./triage-review";

const detail = (over: Partial<TriageDetail["proposal"]> = {}, candidates: TriageDetail["candidates"] = []): TriageDetail => ({
  caseId: "c1",
  caseKey: "REQ-1",
  requestNumber: 1,
  title: "t",
  description: "d",
  businessImpact: null,
  requesterName: "A",
  createdAt: "2026-10-17T00:00:00Z",
  version: 3,
  attachments: [],
  outputId: "o1",
  promptVersion: "v3",
  model: "m",
  proposal: {
    classification: "feature",
    priority: "medium",
    difficulty: "easy",
    requiresHuman: false,
    requiresHumanReasons: [],
    ruleFlags: [],
    confidence: 0.8,
    summary: "s",
    duplicateCandidates: 0,
    classificationReason: "",
    priorityReason: "",
    difficultyReason: "",
    assumptions: [],
    openQuestions: [],
    modelRequiresHumanReasons: [],
    dedupeMode: "trigram",
    ...over,
  },
  candidates,
});

const candidate = (over: Partial<TriageDetail["candidates"][number]> = {}) => ({
  caseId: "orig",
  caseKey: "REQ-9",
  requestNumber: 9,
  title: "x",
  statusLabel: "Đang xử lý",
  trigram: 0.5,
  vector: null,
  modelReason: null,
  namedByModel: true,
  ...over,
});

describe("triage review draft", () => {
  it("starts from the proposal and from the duplicate the agent named", () => {
    expect(draftFromDetail(detail({ requiresHumanReasons: ["data_fix", "production_change"], requiresHuman: true }))).toMatchObject({
      classification: "feature",
      requiresHumanReasons: ["data_fix", "production_change"],
      duplicateOfCaseId: null,
    });
    expect(draftFromDetail(detail({}, [candidate({ namedByModel: false }), candidate({ caseId: "named", namedByModel: true })])).duplicateOfCaseId).toBe("named");
    expect(draftFromDetail(detail({}, [candidate({ namedByModel: false })])).duplicateOfCaseId).toBeNull();
  });

  it("an untouched draft sends nothing; only changed fields are sent; list order does not count as a change", () => {
    const base = draftFromDetail(detail({ requiresHuman: true, requiresHumanReasons: ["data_fix", "production_change"] }));
    expect(finalPatch(base, { ...base })).toBeUndefined();
    expect(changedFields(base, { ...base, requiresHumanReasons: ["production_change", "data_fix"] })).toEqual([]);
    expect(finalPatch(base, { ...base, priority: "high", requiresHumanReasons: ["data_fix"] })).toEqual({ priority: "high", requiresHumanReasons: ["data_fix"] });
    expect(changedFields(base, { ...base, duplicateOfCaseId: "x" })).toEqual(["duplicateOfCaseId"]);
  });

  it("changing a value back to the proposed one is not a correction", () => {
    const base = draftFromDetail(detail());
    expect(changedFields(base, { ...base, priority: "high" })).toEqual(["priority"]);
    expect(changedFields(base, { ...base, priority: base.priority })).toEqual([]);
  });
});

describe("decision blockers", () => {
  const base = draftFromDetail(detail());
  it("requires a reason to request changes and to reject, except a duplicate reject", () => {
    expect(decisionBlocker("request_changes", base, "  ")).toBe("A reason is required.");
    expect(decisionBlocker("reject", base, "")).toBe("A reason is required.");
    expect(decisionBlocker("reject", base, "out of scope")).toBeNull();
    expect(decisionBlocker("reject", { ...base, duplicateOfCaseId: "o" }, "")).toBeNull();
    expect(decisionBlocker("approve", base, "")).toBeNull();
  });
  it("blocks approving a duplicate and reasons without 'needs a developer'", () => {
    expect(decisionBlocker("approve", { ...base, duplicateOfCaseId: "o" }, "")).toMatch(/duplicate/i);
    expect(decisionBlocker("approve", { ...base, requiresHuman: false, requiresHumanReasons: ["data_fix"] }, "")).toMatch(/developer/i);
  });
});

describe("queue helpers", () => {
  const item = (over: Partial<TriageQueueItem["proposal"]>): TriageQueueItem => ({
    caseId: "c",
    caseKey: "REQ-1",
    requestNumber: 1,
    title: "t",
    requesterName: "A",
    attachments: 0,
    createdAt: "2026-10-17T00:00:00Z",
    version: 1,
    outputId: "o",
    promptVersion: "v3",
    proposal: { ...detail().proposal, ...over },
  });
  it("filters by needs-developer and possible duplicate", () => {
    const items = [item({}), item({ requiresHuman: true }), item({ duplicateCandidates: 2 })];
    expect(filterQueue(items, "all")).toHaveLength(3);
    expect(filterQueue(items, "needs_human")).toHaveLength(1);
    expect(filterQueue(items, "possible_duplicate")).toHaveLength(1);
  });
  it("formats age and scores", () => {
    const now = new Date("2026-10-17T12:00:00Z").getTime();
    expect(ageLabel("2026-10-17T11:59:40Z", now)).toBe("just now");
    expect(ageLabel("2026-10-17T11:30:00Z", now)).toBe("30 min");
    expect(ageLabel("2026-10-17T07:00:00Z", now)).toBe("5 h");
    expect(ageLabel("2026-10-14T12:00:00Z", now)).toBe("3 d");
    expect(scoreLabel(null)).toBe("-");
    expect(scoreLabel(0.456)).toBe("0.46");
  });
});
