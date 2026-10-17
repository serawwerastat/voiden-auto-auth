/**
 * Cached auth results, one per project, environment and service.
 *
 * Kept in the renderer's local storage — not in Voiden runtime variables,
 * whose writes Voiden prints to its log.
 */

import type { AuthResult } from "./shared/protocol";

const PREFIX = "auto-auth:token:";
/** Refresh at most this long before expiry… */
const MAX_REFRESH_MARGIN_MS = 60 * 1000;

export interface CacheScope {
  project: string;
  env: string;
}

export interface CachedAuth {
  headers: Record<string, string>;
  expiresAt: number;
  /** When the result was obtained (epoch ms). */
  obtainedAt: number;
}

const keyFor = (scope: CacheScope, service: string) => `${PREFIX}${scope.project}|${scope.env}|${service}`;

/**
 * Still usable: before expiry minus a margin of one minute — or half the
 * token's lifetime, for tokens that live less than two minutes.
 */
export function isFresh(entry: CachedAuth | null, now = Date.now()): entry is CachedAuth {
  if (!entry) return false;
  const margin = Math.min(MAX_REFRESH_MARGIN_MS, Math.max(0, (entry.expiresAt - entry.obtainedAt) / 2));
  return entry.expiresAt - margin > now;
}

export function readCache(scope: CacheScope, service: string): CachedAuth | null {
  try {
    const raw = localStorage.getItem(keyFor(scope, service));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<CachedAuth>;
    return entry.headers && typeof entry.expiresAt === "number"
      ? { headers: entry.headers, expiresAt: entry.expiresAt, obtainedAt: entry.obtainedAt ?? 0 }
      : null;
  } catch {
    return null;
  }
}

export function writeCache(scope: CacheScope, service: string, result: AuthResult, now = Date.now()): CachedAuth {
  const entry: CachedAuth = { headers: result.headers, expiresAt: result.expiresAt, obtainedAt: now };
  try {
    localStorage.setItem(keyFor(scope, service), JSON.stringify(entry));
  } catch {
    // Storage unavailable — the result is used for this request only.
  }
  return entry;
}

export function clearCache(scope: CacheScope, service: string): void {
  try {
    localStorage.removeItem(keyFor(scope, service));
  } catch {
    // Nothing cached.
  }
}

/** A short, non-reversible tag for a set of headers, to recognise them later. */
export function headersTag(headers: Record<string, string>): string {
  let hash = 0;
  for (const ch of JSON.stringify(headers)) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36);
}
