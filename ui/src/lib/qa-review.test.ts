import { describe, expect, it } from "vitest";
import { againstRateText, criteriaSummary, qaDecisionBlocker, reasonLabel, recommendationText } from "./qa-review";

describe("QA sign-off helpers", () => {
  it("needs a reason to send back or reject, and never blocks an approval", () => {
    expect(qaDecisionBlocker("approve", "")).toBeNull();
    expect(qaDecisionBlocker("reject", "  ")).toBeTruthy();
    expect(qaDecisionBlocker("request_changes", "")).toBeTruthy();
    expect(qaDecisionBlocker("request_changes", "AC2 sai")).toBeNull();
  });

  it("explains the codes DevFlow stores, and shows an unknown one as it is", () => {
    expect(reasonLabel("criteria_failed:AC2,AC3")).toBe("Failed: AC2,AC3");
    expect(reasonLabel("criteria_not_verified:AC1")).toBe("Not verified: AC1");
    expect(reasonLabel("checks_failed")).toBe("A command did not pass");
    expect(reasonLabel("high_issue")).toBe("A high-severity issue was found");
    expect(reasonLabel("qa_modified_branch")).toBe("The agent changed the branch");
    expect(reasonLabel("something_new")).toBe("something_new");
  });

  it("words the recommendation and the counts for the queue", () => {
    expect(recommendationText("approve")).toMatch(/approving/);
    expect(recommendationText("changes")).toMatch(/sending it back/);
    expect(recommendationText(null)).toBe("No recommendation");
    expect(criteriaSummary({ total: 5, pass: 3, fail: 1, notVerified: 1 })).toBe("3 of 5 criteria pass (1 failed, 1 not verified)");
    expect(criteriaSummary({ total: 2, pass: 2, fail: 0, notVerified: 0 })).toBe("2 of 2 criteria pass");
  });

  it("shows how often the signer went against the recommendation", () => {
    expect(againstRateText(null)).toBe("no decisions yet");
    expect(againstRateText(0.25)).toBe("25%");
    expect(againstRateText(0)).toBe("0%");
  });
});
