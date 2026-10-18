import { describe, expect, it } from "vitest";
import { accessErrorMessage, expiryLabel, INVITE_STATUS_LABEL, inviteUrl, isEmail } from "./portal-access";

describe("portal access helpers", () => {
  it("builds the invite link from the current origin and the server's path", () => {
    expect(inviteUrl("http://localhost:3100", "/portal/invite/abc")).toBe("http://localhost:3100/portal/invite/abc");
    expect(inviteUrl("https://devflow.example/", "/portal/invite/abc")).toBe("https://devflow.example/portal/invite/abc");
    expect(inviteUrl("https://devflow.example", "portal/invite/abc")).toBe("https://devflow.example/portal/invite/abc");
  });

  it("says how long a link has left", () => {
    const now = new Date("2026-10-18T12:00:00Z").getTime();
    expect(expiryLabel("2026-10-25T12:00:00Z", now)).toBe("7 days left");
    expect(expiryLabel("2026-10-20T11:00:00Z", now)).toBe("2 days left");
    expect(expiryLabel("2026-10-18T20:00:00Z", now)).toBe("less than a day left");
    expect(expiryLabel("2026-10-18T11:00:00Z", now)).toBe("expired");
    expect(expiryLabel("garbage", now)).toBe("");
  });

  it("labels every invite status the server can return", () => {
    expect(Object.keys(INVITE_STATUS_LABEL).sort()).toEqual(["accepted", "expired", "pending", "revoked"]);
  });

  it("checks an email before offering to create the account", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail(" a@b.co ")).toBe(true);
    for (const bad of ["", "a", "a@b", "a b@c.d", "@b.co", `${"x".repeat(250)}@b.co`]) expect(isEmail(bad)).toBe(false);
  });

  it("turns the server's error codes into something to act on", () => {
    expect(accessErrorMessage({ status: 409, body: { code: "account_exists" } })).toMatch(/already exists/);
    expect(accessErrorMessage({ status: 409, body: { code: "no_credential_account" } })).toMatch(/no password/);
    expect(accessErrorMessage({ status: 403, body: { code: "settings_operator_managed" } })).toMatch(/hosting operator/);
    expect(accessErrorMessage({ status: 403, body: {} })).toMatch(/permission/);
    expect(accessErrorMessage({ status: 404, body: {} })).toMatch(/Not found/);
    expect(accessErrorMessage({ status: 500, body: { error: "Boom" } })).toBe("Boom");
    expect(accessErrorMessage(new Error("net"))).toBe("net");
    expect(accessErrorMessage(null)).toMatch(/Something went wrong/);
  });
});
