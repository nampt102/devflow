import { afterEach, describe, expect, it, vi as vitest } from "vitest";
import { ApiError, api, describeError, readErrorBody } from "./api";
import { checkFiles, MAX_FILE_BYTES } from "./files";
import { formatSize } from "./format";
import { parseRoute, pathFor } from "./route";
import { vi } from "./vi";

describe("routes", () => {
  it("parses portal paths with or without the base and a trailing slash", () => {
    expect(parseRoute("/portal")).toEqual({ name: "home" });
    expect(parseRoute("/portal/")).toEqual({ name: "home" });
    expect(parseRoute("/portal/new/")).toEqual({ name: "new" });
    expect(parseRoute("/portal/requests/12")).toEqual({ name: "request", number: 12 });
    expect(parseRoute("/requests/12")).toEqual({ name: "request", number: 12 });
  });

  it("accepts only well-formed invitation tokens and request numbers", () => {
    const token = "A".repeat(43);
    expect(parseRoute(`/portal/invite/${token}`)).toEqual({ name: "invite", token });
    expect(parseRoute("/portal/invite/short")).toEqual({ name: "notfound" });
    expect(parseRoute("/portal/invite/" + "A".repeat(43) + "/x")).toEqual({ name: "notfound" });
    expect(parseRoute("/portal/requests/0")).toEqual({ name: "notfound" });
    expect(parseRoute("/portal/requests/abc")).toEqual({ name: "notfound" });
    expect(parseRoute("/portal/elsewhere")).toEqual({ name: "notfound" });
  });

  it("round-trips through pathFor", () => {
    for (const route of [{ name: "home" }, { name: "new" }, { name: "request", number: 7 }] as const) {
      expect(parseRoute(pathFor(route))).toEqual(route);
    }
  });
});

describe("client file checks", () => {
  const file = (name: string, size = 100) => ({ name, size });
  it("accepts supported types within the limits", () => {
    expect(checkFiles([file("a.png"), file("B.PDF"), file("c.docx"), file("d.csv")])).toBeNull();
  });
  it("rejects too many, unsupported, empty and oversized files with Vietnamese messages", () => {
    expect(checkFiles(Array.from({ length: 6 }, (_, i) => file(`f${i}.png`)))).toBe(vi.files.tooMany);
    expect(checkFiles([file("a.png")], 5)).toBe(vi.files.tooMany);
    expect(checkFiles([file("x.svg")])).toBe(vi.files.badType);
    expect(checkFiles([file("x.html")])).toBe(vi.files.badType);
    expect(checkFiles([file("noextension")])).toBe(vi.files.badType);
    expect(checkFiles([file("a.png", 0)])).toBe(vi.files.empty);
    expect(checkFiles([file("a.png", MAX_FILE_BYTES + 1)])).toBe(vi.files.tooLarge);
  });
  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("error handling", () => {
  it("reads codes and messages from server and auth-library shapes", () => {
    expect(readErrorBody({ error: "Invitation expired", details: { code: "invite_expired" } }, 410)).toEqual({ code: "invite_expired", message: "Invitation expired" });
    expect(readErrorBody({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid" }, 401)).toEqual({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid" });
    expect(readErrorBody(null, 500)).toEqual({ code: undefined, message: "HTTP 500" });
  });

  it("describes errors in Vietnamese and never leaks English server text", () => {
    const cases: Array<[ApiError, string]> = [
      [new ApiError(401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password"), vi.errors.badCredentials],
      [new ApiError(422, "USER_ALREADY_EXISTS", "x"), vi.errors.emailTaken],
      [new ApiError(409, "account_exists", "An account with this email already exists"), vi.errors.accountExists],
      [new ApiError(410, "invite_expired", "x"), vi.errors.inviteExpired],
      [new ApiError(410, "invite_revoked", "x"), vi.errors.inviteRevoked],
      [new ApiError(410, undefined, "x"), vi.errors.inviteUsed],
      [new ApiError(404, undefined, "Invalid invitation link"), vi.errors.inviteInvalid],
      [new ApiError(404, undefined, "Request not found"), vi.errors.notFound],
      [new ApiError(403, undefined, "Not a requester"), vi.errors.notRequester],
      [new ApiError(429, undefined, "Too many"), vi.errors.tooManyRequests],
      [new ApiError(422, "file_too_large", "File is larger than 10 MB"), vi.errors.fileTooLarge],
      [new ApiError(500, undefined, "boom"), vi.errors.generic],
    ];
    for (const [error, expected] of cases) expect(describeError(error)).toBe(expected);
    expect(describeError(new Error("anything"))).toBe(vi.errors.generic);
  });
});

describe("api client", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
  const respond = (status: number, body: unknown) =>
    vitest.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  it("returns the signed-in user or null", async () => {
    globalThis.fetch = respond(200, { user: { id: "u", name: "N", email: "e@x.test" } }) as unknown as typeof fetch;
    expect((await api.session())?.email).toBe("e@x.test");
    globalThis.fetch = respond(200, null) as unknown as typeof fetch;
    expect(await api.session()).toBeNull();
  });

  it("raises ApiError with status and code on failure", async () => {
    globalThis.fetch = respond(410, { error: "used", details: { code: "invite_used" } }) as unknown as typeof fetch;
    await expect(api.acceptInvite("A".repeat(43))).rejects.toMatchObject({ status: 410, code: "invite_used" });
  });

  it("registers through the invitation endpoint with a JSON body and no sign-up call", async () => {
    const fetchMock = respond(201, { companyId: "c", requesterId: "r" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const token = "A".repeat(43);
    await api.registerWithInvite(token, "Nguyễn Văn A", "a@x.test", "password-123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/portal/invites/${token}/register`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Nguyễn Văn A", email: "a@x.test", password: "password-123" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(Object.keys(api)).not.toContain("signUp"); // public sign-up may be closed
  });

  it("surfaces an existing account as a typed error so the form can switch to sign-in", async () => {
    globalThis.fetch = respond(409, { error: "exists", details: { code: "account_exists" } }) as unknown as typeof fetch;
    const error = await api.registerWithInvite("A".repeat(43), "N", "a@x.test", "password-123").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "account_exists" });
    expect(describeError(error)).toBe(vi.errors.accountExists);
  });

  it("maps a network failure to a Vietnamese error", async () => {
    globalThis.fetch = vitest.fn(async () => {
      throw new TypeError("failed");
    }) as unknown as typeof fetch;
    await expect(api.list()).rejects.toMatchObject({ status: 0, message: vi.errors.network });
  });

  it("sends the title, description and files as multipart and omits an empty impact", async () => {
    const fetchMock = respond(201, { number: 1 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const png = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await api.submit({ title: "T", description: "D", businessImpact: "  " }, [png]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get("title")).toBe("T");
    expect(form.get("businessImpact")).toBeNull();
    expect((form.getAll("files")[0] as File).name).toBe("a.png");
    expect((init.headers as Record<string, string> | undefined)?.["Content-Type"]).toBeUndefined(); // the browser sets the boundary
  });
});
