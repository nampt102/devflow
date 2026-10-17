import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router } from "express";

/** Where the built portal lives: monorepo build (portal/dist) or a published copy (server/portal-dist). */
export function findPortalDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url)); // server/{src|dist}/devflow/portal
  const candidates = [path.resolve(here, "../../../portal-dist"), path.resolve(here, "../../../../portal/dist")];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) ?? null;
}

/**
 * Serves the portal SPA at /portal. Mounted before the board UI's catch-all, which would otherwise
 * answer every non-API path with the board shell.
 */
export function portalStaticRouter(distDir: string | null = findPortalDist()): Router | null {
  if (!distDir) return null;
  const indexHtml = path.join(distDir, "index.html");
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  // Hashed build assets never change; a missing one must be a 404, not the HTML shell.
  router.use("/assets", express.static(path.join(distDir, "assets"), { maxAge: "1y", immutable: true, index: false }));
  router.use("/assets", (_req, res) => {
    res.status(404).end();
  });
  router.use(express.static(distDir, { index: false, maxAge: "1h" }));
  router.get(/.*/, (_req, res) => {
    res.status(200).set("Cache-Control", "no-cache").type("html").sendFile(indexHtml);
  });
  return router;
}
