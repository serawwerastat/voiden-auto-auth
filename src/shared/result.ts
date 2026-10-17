/**
 * Turning what an auth script returns into headers plus an expiry.
 */

import type { AuthResult } from "./protocol";

/** Used when the script gives no expiry and the token isn't a JWT. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** What a script may return. A bare string is treated as a bearer token. */
export type ScriptResult =
  | string
  | {
      bearer?: string;
      token?: string;
      headers?: Record<string, unknown>;
      /** Seconds from now. */
      expiresIn?: number | string;
      /** Epoch milliseconds or an ISO date. */
      expiresAt?: number | string;
      /** `false` = run the script before every request. */
      cache?: boolean;
    };

function decodeBase64Url(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
  return atob(b64);
}

/** Expiry (epoch ms) from a JWT's `exp` claim, or `null` if not a JWT. */
export function jwtExpiry(token: string): number | null {
  const payload = String(token).split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function normalizeResult(result: unknown, header: string, now = Date.now()): AuthResult {
  if (result == null) throw new Error("the script returned nothing");
  const r = (typeof result === "string" ? { bearer: result } : result) as Exclude<ScriptResult, string>;
  if (typeof r !== "object") throw new Error("the script must return an object or a token string");

  const headers: Record<string, string> = {};
  if (r.bearer) headers[header] = `Bearer ${r.bearer}`;
  else if (r.token) headers[header] = String(r.token);
  for (const [name, value] of Object.entries(r.headers ?? {})) headers[name] = String(value);
  if (Object.keys(headers).length === 0) {
    throw new Error("the script must return { bearer }, { token } or { headers }");
  }

  let expiresAt: number | null = null;
  if (r.expiresAt !== undefined) {
    expiresAt = typeof r.expiresAt === "number" ? r.expiresAt : Date.parse(r.expiresAt);
  } else if (r.expiresIn !== undefined) {
    expiresAt = now + Number(r.expiresIn) * 1000;
  } else if (r.bearer) {
    expiresAt = jwtExpiry(r.bearer);
  }
  if (expiresAt === null || !Number.isFinite(expiresAt)) expiresAt = now + DEFAULT_TTL_MS;

  return { headers, expiresAt, cache: r.cache !== false };
}
