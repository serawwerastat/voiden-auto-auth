import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TTL_MS, jwtExpiry, normalizeResult } from "../src/shared/result";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const NOW = 1_700_000_000_000;

test("bearer tokens become an Authorization header; JWT expiry is read", () => {
  const token = jwt({ exp: NOW / 1000 + 3600 });
  assert.deepEqual(normalizeResult({ bearer: token }, "Authorization", NOW), {
    headers: { Authorization: `Bearer ${token}` },
    expiresAt: NOW + 3_600_000,
    cache: true,
  });
});

test("a bare string is a bearer token", () => {
  assert.equal(normalizeResult("abc", "Authorization", NOW).headers.Authorization, "Bearer abc");
});

test("token, custom header name and extra headers", () => {
  const r = normalizeResult({ token: "Basic eDp5", headers: { "X-Tenant": 7 } }, "Proxy-Authorization", NOW);
  assert.deepEqual(r.headers, { "Proxy-Authorization": "Basic eDp5", "X-Tenant": "7" });
});

test("expiresIn, expiresAt and the default TTL", () => {
  assert.equal(normalizeResult({ bearer: "opaque", expiresIn: 120 }, "A", NOW).expiresAt, NOW + 120_000);
  assert.equal(normalizeResult({ bearer: "opaque", expiresAt: NOW + 5 }, "A", NOW).expiresAt, NOW + 5);
  assert.equal(normalizeResult({ bearer: "opaque", expiresAt: "2030-01-01T00:00:00Z" }, "A", NOW).expiresAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(normalizeResult({ bearer: "opaque" }, "A", NOW).expiresAt, NOW + DEFAULT_TTL_MS);
});

test("cache: false is passed through", () => {
  assert.equal(normalizeResult({ headers: { "X-Api-Key": "k" }, cache: false }, "A", NOW).cache, false);
});

test("invalid results are rejected with a clear message", () => {
  assert.throws(() => normalizeResult(undefined, "A"), /returned nothing/);
  assert.throws(() => normalizeResult({}, "A"), /must return \{ bearer \}/);
  assert.throws(() => normalizeResult(42, "A"), /object or a token string/);
});

test("jwtExpiry", () => {
  assert.equal(jwtExpiry(jwt({ exp: 100 })), 100_000);
  assert.equal(jwtExpiry(jwt({ sub: "x" })), null);
  assert.equal(jwtExpiry("not-a-jwt"), null);
  assert.equal(jwtExpiry("a.%%%.c"), null);
});
