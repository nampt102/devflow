import type { RequestHandler } from "express";
import { tooManyRequests } from "../../errors.js";

/**
 * Sliding-window limit per client IP for the unauthenticated portal endpoints (register, accept).
 * In process memory: it is per server instance and depends on the proxy settings behind `req.ip`.
 */
export function ipRateLimit(opts: { max: number; windowMs: number }): RequestHandler {
  const hits = new Map<string, number[]>();
  return (req, _res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (recent.length >= opts.max) {
      hits.set(key, recent);
      next(tooManyRequests("Too many attempts; try again in a minute"));
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) {
      for (const [ip, times] of hits) if (!times.some((t) => now - t < opts.windowMs)) hits.delete(ip);
    }
    next();
  };
}
