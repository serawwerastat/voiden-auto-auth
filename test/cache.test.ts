import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { clearCache, headersTag, isFresh, readCache, writeCache } from "../src/cache";

const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => void storage.set(k, v),
  removeItem: (k) => void storage.delete(k),
};
beforeEach(() => storage.clear());

const NOW = 1_700_000_000_000;

test("fresh until a minute before expiry for normal tokens", () => {
  const entry = { headers: {}, obtainedAt: NOW, expiresAt: NOW + 3_600_000 };
  assert.ok(isFresh(entry, NOW + 3_600_000 - 61_000));
  assert.ok(!isFresh(entry, NOW + 3_600_000 - 59_000));
});

test("short-lived tokens are reused for the first half of their life", () => {
  const entry = { headers: {}, obtainedAt: NOW, expiresAt: NOW + 30_000 };
  assert.ok(isFresh(entry, NOW + 10_000));
  assert.ok(!isFresh(entry, NOW + 16_000));
  assert.ok(!isFresh(null));
});

test("entries are separate per project, environment and service", () => {
  const result = { headers: { Authorization: "Bearer a" }, expiresAt: NOW + 1000, cache: true };
  writeCache({ project: "/p", env: "dev" }, "api", result, NOW);
  assert.deepEqual(readCache({ project: "/p", env: "dev" }, "api"), { headers: result.headers, expiresAt: NOW + 1000, obtainedAt: NOW });
  assert.equal(readCache({ project: "/p", env: "prod" }, "api"), null);
  assert.equal(readCache({ project: "/q", env: "dev" }, "api"), null);
  assert.equal(readCache({ project: "/p", env: "dev" }, "other"), null);
  clearCache({ project: "/p", env: "dev" }, "api");
  assert.equal(readCache({ project: "/p", env: "dev" }, "api"), null);
});

test("headersTag tells header sets apart without exposing them", () => {
  const a = headersTag({ Authorization: "Bearer one" });
  assert.equal(a, headersTag({ Authorization: "Bearer one" }));
  assert.notEqual(a, headersTag({ Authorization: "Bearer two" }));
  assert.ok(!a.includes("one"));
});
