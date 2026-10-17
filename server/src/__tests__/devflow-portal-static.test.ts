import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { portalStaticRouter } from "../devflow/portal/static.js";

describe("portal static serving", () => {
  const dist = mkdtempSync(join(tmpdir(), "devflow-portal-dist-"));
  let app: express.Express;

  beforeAll(() => {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>portal-shell</title>");
    writeFileSync(join(dist, "assets", "app.abc123.js"), "console.log(1)");
    writeFileSync(join(dist, "favicon.svg"), "<svg/>");
    app = express();
    app.use("/portal", portalStaticRouter(dist)!);
    // stands in for the board UI catch-all that is mounted after the portal
    app.get(/.*/, (_req, res) => res.status(200).send("board-shell"));
  });

  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it("returns null when there is no build", () => {
    expect(portalStaticRouter(null)).toBeNull();
  });

  it("serves the shell at the base and for client-side routes, never the board shell", async () => {
    for (const path of ["/portal", "/portal/", "/portal/requests/12", "/portal/invite/" + "A".repeat(43), "/portal/new"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain("portal-shell");
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
    expect((await request(app).get("/elsewhere")).text).toBe("board-shell");
  });

  it("caches hashed assets for a year and answers a missing asset with 404 instead of HTML", async () => {
    const hit = await request(app).get("/portal/assets/app.abc123.js");
    expect(hit.status).toBe(200);
    expect(hit.headers["cache-control"]).toMatch(/max-age=31536000.*immutable/);
    const miss = await request(app).get("/portal/assets/missing.js");
    expect(miss.status).toBe(404);
    expect(miss.text).not.toContain("portal-shell");
  });

  it("serves plain static files and sets framing and sniffing protections", async () => {
    const res = await request(app).get("/portal/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("same-origin");
  });
});
