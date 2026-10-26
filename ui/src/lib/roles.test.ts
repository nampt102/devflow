import { describe, expect, it } from "vitest";
import { accessBlocker, rolesChanged, rolesErrorMessage, rolesSentence, toggleRole } from "./roles";

describe("roles", () => {
  it("names roles in a sentence", () => {
    expect(rolesSentence(["tech_lead"])).toBe("Tech Lead");
    expect(rolesSentence(["ba", "tech_lead"])).toBe("BA or Tech Lead");
    expect(rolesSentence(["qa", "tech_lead"])).toBe("QA or Tech Lead");
    expect(rolesSentence([])).toBe("");
  });

  it("explains why a viewer cannot decide, and says nothing when they can", () => {
    expect(accessBlocker({ canDecide: true, requiredRoles: ["ba"] })).toBeNull();
    expect(accessBlocker({ canDecide: false, requiredRoles: ["ba", "tech_lead"] })).toContain("BA or Tech Lead");
    expect(accessBlocker({ canDecide: false, requiredRoles: [] })).toContain("not the person assigned");
  });

  it("toggles a role and keeps the server's order", () => {
    const all = ["ba", "tech_lead"];
    expect(toggleRole(["tech_lead"], "ba", true, all)).toEqual(["ba", "tech_lead"]);
    expect(toggleRole(["ba", "tech_lead"], "ba", false, all)).toEqual(["tech_lead"]);
    expect(toggleRole([], "ba", false, all)).toEqual([]);
  });

  it("sees a change regardless of order", () => {
    expect(rolesChanged(["ba", "tech_lead"], ["tech_lead", "ba"])).toBe(false);
    expect(rolesChanged(["ba"], [])).toBe(true);
    expect(rolesChanged([], ["tech_lead"])).toBe(true);
  });

  it("turns errors into short sentences", () => {
    expect(rolesErrorMessage({ status: 403 })).toContain("owner");
    expect(rolesErrorMessage({ status: 422, body: { error: "That person is not an active member of this company" } })).toContain("not an active member");
  });
});
