// Fail-closed secret auth for this MCP server (2026-10-30, Bright Engine
// security law rule 1: no service on a public domain without authentication).
//
// The secret is MCP_API_KEY (at least 32 characters). It is accepted two ways,
// so every MCP client can use it:
//   - Authorization: Bearer <MCP_API_KEY>   (Claude Code, scripts)
//   - the URL path  /k/<MCP_API_KEY>/mcp    (claude.ai connectors, which
//                                            cannot send a custom header)
// With MCP_API_KEY unset or too short every MCP route answers 503: the server
// never runs open. Only /health stays public. The comparison is constant-time
// (sha256 of both sides, then timingSafeEqual), and the secret is never logged.
import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

export const MIN_KEY_LENGTH = 32;

/** The client's address as Railway's edge forwards it (first hop of X-Forwarded-For). */
export function clientIp(req: Request): string {
  const fwd = req.get("x-forwarded-for") || "";
  return (fwd.split(",")[0] || req.ip || "").trim() || "unknown";
}

export function createAuth(key: string | undefined = process.env.MCP_API_KEY) {
  const secret = typeof key === "string" ? key : "";
  const configured = secret.length >= MIN_KEY_LENGTH;
  const expected = crypto.createHash("sha256").update(secret).digest();

  /** Constant-time check of a presented secret. Never true while unconfigured. */
  function matches(given: unknown): boolean {
    if (!configured || typeof given !== "string" || given.length === 0) return false;
    const h = crypto.createHash("sha256").update(given).digest();
    return crypto.timingSafeEqual(h, expected);
  }

  function refuseUnconfigured(res: Response): void {
    res.status(503).json({ error: "MCP auth is not configured on this server (MCP_API_KEY)" });
  }

  /** Middleware: Authorization: Bearer <key>. */
  function bearer(req: Request, res: Response, next: NextFunction): void {
    if (!configured) return refuseUnconfigured(res);
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get("authorization") || "");
    if (m && matches(m[1])) return next();
    console.warn(`[auth] refused ${req.method} (no or bad bearer) from ${clientIp(req)}`);
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
  }

  /** Middleware for routes mounted at /k/:key. A wrong key is a plain 404 (nothing to discover). */
  function pathKey(req: Request, res: Response, next: NextFunction): void {
    if (!configured) return refuseUnconfigured(res);
    if (matches(req.params.key)) return next();
    console.warn(`[auth] refused ${req.method} (bad path key) from ${clientIp(req)}`);
    res.status(404).end();
  }

  return { configured, matches, bearer, pathKey };
}
