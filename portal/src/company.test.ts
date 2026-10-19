import { describe, expect, it } from "vitest";
import { chooseCompany, COMPANY_KEY, readSavedCompany, saveCompany, withCompany } from "./company";

const a = { companyId: "a", name: "Alpha" };
const b = { companyId: "b", name: "Beta" };

describe("choosing the company", () => {
  it("has nothing to choose when the person is a requester nowhere", () => {
    expect(chooseCompany([], null)).toEqual({ kind: "none" });
    expect(chooseCompany([], "a")).toEqual({ kind: "none" });
  });

  it("uses the only company without asking, whatever was saved", () => {
    expect(chooseCompany([a], null)).toEqual({ kind: "use", companyId: "a" });
    expect(chooseCompany([a], "gone")).toEqual({ kind: "use", companyId: "a" });
  });

  it("asks when there are several and nothing usable was saved", () => {
    expect(chooseCompany([a, b], null)).toEqual({ kind: "ask" });
    expect(chooseCompany([a, b], "gone")).toEqual({ kind: "ask" }); // that company no longer lists them
  });

  it("reuses the saved company when it is still one of theirs", () => {
    expect(chooseCompany([a, b], "b")).toEqual({ kind: "use", companyId: "b" });
  });
});

describe("remembering the company", () => {
  it("round-trips through storage, and survives storage being blocked", () => {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    try {
      expect(readSavedCompany()).toBeNull();
      saveCompany("b");
      expect(store.get(COMPANY_KEY)).toBe("b");
      expect(readSavedCompany()).toBe("b");
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } },
      });
      expect(readSavedCompany()).toBeNull();
      expect(() => saveCompany("a")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
    }
  });
});

describe("telling the server which company", () => {
  it("adds companyId to the calls that act inside a company", () => {
    expect(withCompany("/api/portal/me", "c1")).toBe("/api/portal/me?companyId=c1");
    expect(withCompany("/api/portal/requests", "c1")).toBe("/api/portal/requests?companyId=c1");
    expect(withCompany("/api/portal/requests/7", "c1")).toBe("/api/portal/requests/7?companyId=c1");
    expect(withCompany("/api/portal/requests/7/attachments/x", "c1")).toBe("/api/portal/requests/7/attachments/x?companyId=c1");
    expect(withCompany("/api/portal/requests?limit=5", "c1")).toBe("/api/portal/requests?limit=5&companyId=c1");
    expect(withCompany("/api/portal/requests", "a b&c")).toBe("/api/portal/requests?companyId=a%20b%26c");
  });

  it("leaves everything else alone: invitations, the company list, sign-in, and calls before a company is known", () => {
    for (const path of ["/api/portal/companies", "/api/portal/invites/tok/accept", "/api/portal/invites/tok/register", "/api/auth/sign-in/email", "/api/auth/get-session"]) {
      expect(withCompany(path, "c1"), path).toBe(path);
    }
    expect(withCompany("/api/portal/me", null)).toBe("/api/portal/me");
  });
});
