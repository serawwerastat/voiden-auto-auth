import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isInside, runScript, type RunDeps } from "../src/main/runScript";
import type { Fetch } from "../src/main/http";
import { fakeTrust, tempDir } from "./helpers";

let project: string;
let outside: string;
let answer = true;
let trust: ReturnType<typeof fakeTrust>;
const env: Record<string, string> = { api_url: "https://api.example.com", api_user: "jane", api_password: "s3cret" };
const resolve = async (t: string) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => env[k] ?? m);
const requests: { url: string; body: unknown }[] = [];
const fetchStub: Fetch = async (url, init) => {
  requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(JSON.stringify({ token: "tok-1", expires_in: 300 }), { status: 200 });
};
const deps = (): RunDeps => ({ resolve, fetch: fetchStub, trust: trust.deps });
const req = (script: string) => ({
  service: "my-api",
  header: "Authorization",
  scriptPath: path.join(project, script),
  request: { url: "https://api.example.com/users", method: "GET", file: "users/List.void" },
});
const write = (rel: string, content: string) => writeFileSync(path.join(project, rel), content);

before(() => {
  project = tempDir("auto-auth-");
  outside = tempDir("auto-auth-outside-");
  trust = fakeTrust(tempDir("auto-auth-trust-"), () => answer);
  mkdirSync(path.join(project, ".voiden-auth/lib"), { recursive: true });
  mkdirSync(path.join(project, "other"), { recursive: true });
  write(".voiden-auth/lib/helper.js", "module.exports = { prefix: 'Bearer ' };");
  write(
    ".voiden-auth/login.js",
    `const res = await auth.send({ method: "POST", url: "{{api_url}}/login", json: { user: "{{api_user}}", password: "{{api_password}}" } });
     return { bearer: res.json.token, expiresIn: res.json.expires_in };`,
  );
  write(
    ".voiden-auth/node.js",
    `const helper = require("./lib/helper");
     const crypto = require("node:crypto");
     const builtin = await import("node:os");
     const { readFileSync } = require("node:fs");
     const here = readFileSync(__filename, "utf8").length > 0;
     const sig = crypto.createHmac("sha256", await auth.env("api_password")).update("x").digest("hex").slice(0, 8);
     return { token: helper.prefix + sig, headers: { "X-Here": here, "X-Os": typeof builtin.platform, "X-Missing": String(await auth.env("not_set")) }, cache: false };`,
  );
  write(".voiden-auth/empty.js", "   \n");
  write(".voiden-auth/nothing.js", "auth.log('no return');");
  write(".voiden-auth/logs.js", "auth.log('hello', { n: 1 }, 2); return 'tok';");
  write(".voiden-auth/slow.js", "await new Promise((r) => setTimeout(r, 1000)); return 'late';");
  write("other/a.js", "return 'a';");
  writeFileSync(path.join(outside, "evil.js"), "return 'evil';");
});

after(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("runs a login script with auth.send and returns normalised headers", async () => {
  const now = Date.now();
  const result = await runScript(req(".voiden-auth/login.js"), project, deps());
  assert.deepEqual(result.headers, { Authorization: "Bearer tok-1" });
  assert.ok(result.expiresAt >= now + 300_000 && result.expiresAt < now + 302_000);
  assert.deepEqual(requests.at(-1), { url: "https://api.example.com/login", body: { user: "jane", password: "s3cret" } });
});

test("scripts can use require (relative, built-in) and import() for built-ins", async () => {
  const result = await runScript(req(".voiden-auth/node.js"), project, deps());
  assert.match(result.headers.Authorization, /^Bearer [0-9a-f]{8}$/);
  assert.equal(result.headers["X-Here"], "true");
  assert.equal(result.headers["X-Os"], "function");
  assert.equal(result.headers["X-Missing"], "undefined", "auth.env returns undefined for unset variables");
  assert.equal(result.cache, false);
});

test("edited helper files are picked up without a restart", async () => {
  write(".voiden-auth/lib/helper.js", "module.exports = { prefix: 'Token ' };");
  const result = await runScript(req(".voiden-auth/node.js"), project, deps());
  assert.match(result.headers.Authorization, /^Token /);
});

test("approval: asked once, again when the script's folder changes, never for a declined script", async () => {
  const before = trust.asked.length;
  await runScript(req("other/a.js"), project, deps());
  await runScript(req("other/a.js"), project, deps());
  assert.equal(trust.asked.length, before + 1, "asked once for unchanged content");
  assert.match(trust.asked.at(-1)!, /^Run the auth script other\/a\.js\?$/);

  write("other/helper.js", "module.exports = 1;"); // a file next to the script changes
  await runScript(req("other/a.js"), project, deps());
  assert.equal(trust.asked.length, before + 2);
  assert.match(trust.asked.at(-1)!, /has changed since you allowed it/);

  write("other/a.js", "return 'b';");
  answer = false;
  await assert.rejects(runScript(req("other/a.js"), project, deps()), /running other\/a\.js was not allowed/);
  answer = true;
});

test("auth.log lines are returned", async () => {
  const result = await runScript(req(".voiden-auth/logs.js"), project, deps());
  assert.deepEqual(result.logs, ['hello {"n":1} 2']);
});

test("scripts outside the project are refused, including through symlinks", async () => {
  await assert.rejects(runScript({ ...req("x.js"), scriptPath: path.join(outside, "evil.js") }, project, deps()), /outside the project/);
  await assert.rejects(runScript(req("../escape.js"), project, deps()), /not found|outside the project/);
  // A directory link inside the project pointing outside it. "junction" works
  // on Windows without admin rights or Developer Mode; elsewhere it's an
  // ordinary directory symlink.
  symlinkSync(outside, path.join(project, "linked-dir"), "junction");
  await assert.rejects(runScript(req("linked-dir/evil.js"), project, deps()), /outside the project/);
});

test("missing, empty, result-less and slow scripts give clear errors", async () => {
  await assert.rejects(runScript(req(".voiden-auth/missing.js"), project, deps()), /\.voiden-auth\/missing\.js not found/);
  await assert.rejects(runScript(req(".voiden-auth/empty.js"), project, deps()), /is empty/);
  await assert.rejects(runScript(req(".voiden-auth/nothing.js"), project, deps()), /returned nothing/);
  await assert.rejects(
    runScript(req(".voiden-auth/slow.js"), project, { ...deps(), timeoutMs: 50 }),
    /script \.voiden-auth\/slow\.js did not finish within 0\.05 s/,
  );
});

test("isInside", () => {
  assert.ok(isInside("/p", "/p/a/b.js"));
  assert.ok(isInside("/p", "/p"));
  assert.ok(!isInside("/p", "/p2/a.js"));
  assert.ok(!isInside("/p", "/p/../x.js"));
});