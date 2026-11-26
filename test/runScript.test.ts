import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import Module from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { isInside } from "../src/main/paths";
import { runScript, type RunDeps } from "../src/main/runScript";
import type { Answer } from "../src/main/trust";
import { fakeTrust, tempDir } from "./helpers";

let project: string;
let outside: string;
let userDataDir: string;
let trustDir: string;
let server: Server;
let answer: Answer | (() => Answer) = "allow";
let trust: ReturnType<typeof fakeTrust>;
const env: Record<string, string> = { api_user: "jane", api_password: 's3"cret' };
const resolve = async (t: string) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => env[k] ?? m);
const requests: { url: string; body: unknown }[] = [];

const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({ resolve, trust: trust.deps, userDataDir, ...extra });
const req = (script: string) => ({
  service: "my-api",
  header: "Authorization",
  scriptPath: path.join(project, script),
  request: { url: "https://api.example.com/users", method: "GET", file: "users/List.void" },
});
const write = (rel: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  writeFileSync(path.join(project, rel), content);
};
const run = (script: string, extra?: Partial<RunDeps>) => runScript(req(script), project, deps(extra));
const token = async (script: string) => (await run(script)).headers.Authorization;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Files outside its folder that the stored approval of `script` holds, as project-relative paths. */
const approvedLoads = (script: string): string[] => {
  const all = JSON.parse(readFileSync(path.join(trustDir, "trusted.json"), "utf8")) as Record<string, { loaded: object }>;
  const slashes = (p: string) => p.replace(/\\/g, "/");
  const key = Object.keys(all).find((k) => slashes(k).endsWith(`/${script}`))!;
  const root = slashes(key).slice(0, -script.length);
  return Object.keys(all[key].loaded).map((file) => slashes(file).replace(root, "")).sort();
};

before(async () => {
  project = tempDir("auto-auth-");
  outside = tempDir("auto-auth-outside-");
  userDataDir = tempDir("auto-auth-userdata-");
  trustDir = tempDir("auto-auth-trust-");
  trust = fakeTrust(trustDir, () => (typeof answer === "function" ? answer() : answer));

  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body: body ? JSON.parse(body) : undefined });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ token: "tok-1", expires_in: 300 }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  env.api_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
     const here = readFileSync(__filename, "utf8").length > 0 && __dirname.endsWith(".voiden-auth");
     const sig = crypto.createHmac("sha256", await auth.env("api_password")).update("x").digest("hex").slice(0, 8);
     return {
       token: helper.prefix + sig,
       headers: { "X-Here": here, "X-Os": typeof builtin.platform, "X-Missing": String(await auth.env("not_set")), "X-For": auth.service + " " + auth.request.file },
       cache: false,
     };`,
  );
  write(".voiden-auth/empty.js", "   \n");
  write(".voiden-auth/nothing.js", "auth.log('no return');");
  write(".voiden-auth/logs.js", "auth.log('hello', { n: 1 }, 2); return 'tok';");
  write(".voiden-auth/fails.js", "auth.log('step 1'); auth.log('step 2'); throw new Error('boom');");
  write(
    ".voiden-auth/slow.js",
    "await new Promise((r) => setTimeout(r, 400)); require('node:fs').writeFileSync(__dirname + '/../slow-finished.txt', ''); return 'late';",
  );
  write(".voiden-auth/hangs.js", "while (true) {}");
  write(".voiden-auth/exits.js", "process.exit(3);");
  write(".voiden-auth/throws-later.js", "setTimeout(() => { throw new Error('thrown later'); }, 5); await new Promise(() => {});");
  write(".voiden-auth/odd-result.js", "return { bearer: 'tok', helper() {}, big: 10n };");
  write(".voiden-auth/noise.js", "const { parentPort } = require('node:worker_threads'); parentPort.postMessage(null); parentPort.postMessage({ type: 'loaded', file: 'x', hash: 1 }); return 'tok';");
  // Not valid UTF-8: a Latin-1 "é" in a comment.
  write(".voiden-auth/latin1.js", Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from("\nreturn 'tok';")]));
  write("other/a.js", "return 'a';");
  write("..hidden/a.js", "return 'hidden';");
  write("root.js", "return 'root';");
  writeFileSync(path.join(outside, "evil.js"), "return 'evil';");
});

after(async () => {
  await new Promise((done) => server.close(done));
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("runs a login script with auth.send and returns normalised headers", async () => {
  const now = Date.now();
  const result = await run(".voiden-auth/login.js");
  assert.deepEqual(result.headers, { Authorization: "Bearer tok-1" });
  assert.ok(result.expiresAt >= now + 300_000 && result.expiresAt < now + 305_000);
  assert.equal(result.cache, true);
  assert.deepEqual(requests.at(-1), { url: "/login", body: { user: "jane", password: 's3"cret' } });
});

test("scripts can use require (relative, built-in), import() for built-ins, and the auth helpers", async () => {
  const result = await run(".voiden-auth/node.js");
  assert.match(result.headers.Authorization, /^Bearer [0-9a-f]{8}$/);
  assert.equal(result.headers["X-Here"], "true");
  assert.equal(result.headers["X-Os"], "function");
  assert.equal(result.headers["X-Missing"], "undefined", "auth.env returns undefined for unset variables");
  assert.equal(result.headers["X-For"], "my-api users/List.void");
  assert.equal(result.cache, false);
});

test("an edited helper is used on the next run, after the user allowed it — no restart needed", async () => {
  const before = trust.asked.length;
  write(".voiden-auth/lib/helper.js", "module.exports = { prefix: 'Token ' };");
  assert.match(await token(".voiden-auth/node.js"), /^Token /);
  assert.equal(trust.asked.length, before + 1);
  assert.match(trust.details.at(-1)!, /• \.voiden-auth\/lib\/helper\.js \(changed\)/);
});

test("approval: asked once, again when the script's folder changes, never run when declined", async () => {
  const before = trust.asked.length;
  await run("other/a.js");
  await run("other/a.js");
  assert.equal(trust.asked.length, before + 1, "asked once for unchanged content");
  assert.equal(trust.asked.at(-1), "Run the auth script other/a.js?");
  assert.match(trust.details.at(-1)!, /other\/a\.js starts with:\n\nreturn 'a';/);

  write("other/helper.js", "module.exports = 1;"); // a file next to the script appears
  await run("other/a.js");
  assert.equal(trust.asked.length, before + 2);
  assert.match(trust.details.at(-1)!, /• other\/helper\.js \(added\)/);

  write("other/a.js", "require('node:fs').writeFileSync(__dirname + '/../declined-ran.txt', ''); return 'b';");
  answer = "deny";
  await assert.rejects(run("other/a.js"), /running other\/a\.js was not allowed/);
  answer = "open";
  await assert.rejects(run("other/a.js"), /other\/a\.js was opened for review/);
  answer = "allow";
  assert.ok(!existsSync(path.join(project, "declined-ran.txt")), "the declined script never ran");
});

test("parallel runs of a script ask once, and one Cancel answers them all", async () => {
  write("shared/common.js", "module.exports = 'p';");
  write("parallel/a.js", "return require('../shared/common');");
  let questions = 0;
  let reply: Answer = "deny";
  const slowTrust = {
    store: trust.deps.store,
    ask: async () => {
      questions++;
      await sleep(50);
      return reply;
    },
  };
  const three = () => Promise.allSettled([1, 2, 3].map(() => run("parallel/a.js", { trust: slowTrust })));

  const declined = await three();
  assert.deepEqual(declined.map((r) => r.status === "rejected" && String(r.reason.message)), Array(3).fill("running parallel/a.js was not allowed"));
  assert.equal(questions, 1, "the runs waiting behind the question were declined with it");

  reply = "allow";
  const allowed = await three();
  assert.deepEqual(allowed.map((r) => r.status === "fulfilled" && r.value.headers.Authorization), Array(3).fill("Bearer p"));
  assert.equal(questions, 2, "asked once; the waiting runs found the script, and what it loads, allowed");
});

test("files loaded from outside the script's folder join the approval, and must then stay as they are", async () => {
  write("shared/sign.js", "module.exports = (text) => 'signed-' + text + require('./salt');");
  write("shared/salt.js", "module.exports = '-1';");
  write("node_modules/some-pkg/package.json", JSON.stringify({ name: "some-pkg", main: "main.js" }));
  write("node_modules/some-pkg/main.js", "module.exports = { version: 1 };");
  write("signed/auth.js", "const pkg = require('some-pkg'); return require('../shared/sign')('v' + pkg.version);");

  const before = trust.asked.length;
  assert.equal(await token("signed/auth.js"), "Bearer signed-v1-1");
  assert.deepEqual(approvedLoads("signed/auth.js"), [
    "node_modules/some-pkg/main.js",
    "node_modules/some-pkg/package.json", // decides which file of the package loads
    "shared/salt.js",
    "shared/sign.js",
  ]);
  assert.equal(await token("signed/auth.js"), "Bearer signed-v1-1");
  assert.equal(trust.asked.length, before + 1, "what it loaded was recorded without asking again");

  // A helper of a helper, elsewhere in the project, changes — e.g. after a git pull.
  write("shared/salt.js", "module.exports = '-2';");
  assert.equal(await token("signed/auth.js"), "Bearer signed-v1-2");
  assert.equal(trust.asked.length, before + 2);
  assert.match(trust.details.at(-1)!, /Since you allowed it:\n  • shared\/salt\.js \(changed\)/);

  // A package in node_modules changes — e.g. after an npm install.
  write("node_modules/some-pkg/main.js", "module.exports = { version: 2 };");
  assert.equal(await token("signed/auth.js"), "Bearer signed-v2-2");
  assert.equal(trust.asked.length, before + 3);
  assert.match(trust.details.at(-1)!, /• node_modules\/some-pkg\/main\.js \(changed\)/);

  // Unrelated files elsewhere in the project don't matter.
  write("shared/unrelated.js", "module.exports = 0;");
  write("users/List.void", "changed");
  await token("signed/auth.js");
  assert.equal(trust.asked.length, before + 3);
});

test("a different file taking an approved file's place is stopped before it runs", async () => {
  const ran = path.join(project, "swapped-ran.txt");
  const evil = `require('node:fs').writeFileSync(${JSON.stringify(ran)}, ''); module.exports = { version: 'evil' };`;
  const original = JSON.stringify({ name: "some-pkg", main: "main.js" });

  // A package placed closer to the script shadows the approved one: no approved file changed.
  let before = trust.asked.length;
  write("signed/node_modules/some-pkg/index.js", evil);
  answer = "deny";
  await assert.rejects(token("signed/auth.js"), /running signed\/auth\.js was not allowed/);
  assert.equal(trust.asked.length, before + 1);
  assert.equal(trust.asked.at(-1), "The auth script signed/auth.js wants to load a file you haven't allowed yet. Run it?");
  assert.match(trust.details.at(-1)!, /• signed\/node_modules\/some-pkg\/index\.js \(not loaded before\)/);
  assert.ok(!existsSync(ran), "nothing of the new file ran");
  rmSync(path.join(project, "signed/node_modules"), { recursive: true });

  // A harmless-looking change arrives together with a repointed entry point.
  // Allowing the changes that are listed must not let the new file in.
  before = trust.asked.length;
  write("signed/notes.txt", "updated");
  write("node_modules/some-pkg/other.js", evil);
  write("node_modules/some-pkg/package.json", JSON.stringify({ name: "some-pkg", main: "other.js" }));
  const answers: Answer[] = ["allow", "deny"];
  answer = () => answers.shift() ?? "deny";
  await assert.rejects(token("signed/auth.js"), /was not allowed/);
  assert.equal(trust.asked.length, before + 2);
  assert.match(trust.details.at(-2)!, /• node_modules\/some-pkg\/package\.json \(changed\)\n  • signed\/notes\.txt \(added\)/);
  assert.match(trust.details.at(-2)!, /still can't load a file you haven't allowed/);
  assert.match(trust.details.at(-1)!, /• node_modules\/some-pkg\/other\.js \(not loaded before\)/);
  assert.ok(!existsSync(ran), "nothing of the new file ran");

  // Allowed, it runs, and joins the approval.
  answer = "allow";
  assert.equal(await token("signed/auth.js"), "Bearer signed-vevil-2");
  assert.ok(existsSync(ran));
  const asked = trust.asked.length;
  await token("signed/auth.js");
  assert.equal(trust.asked.length, asked, "not asked again");

  // Pointing the package back at a file that is approved too is still a change to ask about.
  write("node_modules/some-pkg/package.json", original);
  assert.equal(await token("signed/auth.js"), "Bearer signed-v2-2");
  assert.equal(trust.asked.length, asked + 1);
  assert.match(trust.details.at(-1)!, /• node_modules\/some-pkg\/package\.json \(changed\)/);
});

test("a file is checked at the moment it is loaded, not only before the run", async () => {
  write("shared/gen.js", "module.exports = 'v1';");
  write(
    "generated/auth.js",
    `const fs = require("node:fs"), path = require("node:path");
     // Rewrites its helper just before loading it, once a flag file exists.
     if (fs.existsSync(path.join(__dirname, "../flags/rewrite"))) fs.writeFileSync(path.join(__dirname, "../shared/gen.js"), "module.exports = 'v2';");
     return require("../shared/gen");`,
  );
  assert.equal(await token("generated/auth.js"), "Bearer v1");

  const before = trust.asked.length;
  write("flags/rewrite", "");
  assert.equal(await token("generated/auth.js"), "Bearer v2");
  assert.equal(trust.asked.length, before + 1);
  assert.match(trust.details.at(-1)!, /• shared\/gen\.js \(changed\)/);
});

test("a script that rewrites a file it then requires gets one question and a clear error", async () => {
  write(
    "stateful/auth.js",
    `const fs = require("node:fs"), file = __dirname + "/state.json";
     fs.writeFileSync(file, JSON.stringify({ at: process.hrtime.bigint().toString() }));
     return require(file).at;`,
  );
  await run("stateful/auth.js"); // the first run may load it
  const before = trust.asked.length;
  await assert.rejects(
    run("stateful/auth.js"),
    /stateful\/state\.json is different every time stateful\/auth\.js runs, so it can't be approved\. If the script writes this file itself, read it with fs instead of require\(\)/,
  );
  assert.equal(trust.asked.length, before + 1);
});

test("a file a script creates and loads on its first run isn't a change afterwards", async () => {
  write(
    "caching/auth.js",
    `const fs = require("node:fs"), file = __dirname + "/config.json";
     if (!fs.existsSync(file)) fs.writeFileSync(file, '{"v":1}');
     return "v" + require(file).v;`,
  );
  const before = trust.asked.length;
  assert.equal(await token("caching/auth.js"), "Bearer v1");
  assert.equal(await token("caching/auth.js"), "Bearer v1");
  assert.equal(trust.asked.length, before + 1);
});

test("a file edited while the dialog is open is asked about again", async () => {
  write("shared/late.js", "module.exports = 'a';");
  write("dialog/auth.js", "return require('../shared/late');");
  assert.equal(await token("dialog/auth.js"), "Bearer a");

  const before = trust.asked.length;
  write("shared/late.js", "module.exports = 'b';");
  let edited = false;
  answer = () => {
    if (!edited) write("shared/late.js", "module.exports = 'c';");
    edited = true;
    return "allow";
  };
  assert.equal(await token("dialog/auth.js"), "Bearer c");
  assert.equal(trust.asked.length, before + 2);
  answer = "allow";
});

test("what a run loaded is remembered even when it ends badly", async () => {
  write("shared/first.js", "module.exports = 1;");
  write("crash/auth.js", "require('../shared/first'); process.exit(1);");
  await assert.rejects(run("crash/auth.js"), /exited before returning a result/);
  assert.deepEqual(approvedLoads("crash/auth.js"), ["shared/first.js"]);

  const before = trust.asked.length;
  write("shared/first.js", "module.exports = 2;");
  await assert.rejects(run("crash/auth.js"), /exited before returning a result/);
  assert.equal(trust.asked.length, before + 1);
});

test("ES modules a script loads are checked too", { skip: typeof (Module as { registerHooks?: unknown }).registerHooks !== "function" && "needs Node.js 22.15 or later" }, async () => {
  write("node_modules/esm-pkg/package.json", JSON.stringify({ name: "esm-pkg", type: "module", exports: "./index.js" }));
  write("node_modules/esm-pkg/index.js", "import { part } from './part.js'; export const value = 'esm-' + part;");
  write("node_modules/esm-pkg/part.js", "export const part = 1;");
  write("esm/auth.js", "return require('esm-pkg').value;");
  assert.equal(await token("esm/auth.js"), "Bearer esm-1");
  assert.deepEqual(approvedLoads("esm/auth.js"), [
    "node_modules/esm-pkg/index.js",
    "node_modules/esm-pkg/package.json",
    "node_modules/esm-pkg/part.js",
  ]);

  const before = trust.asked.length;
  write("node_modules/esm-pkg/part.js", "export const part = 2;"); // a file the entry module imports
  assert.equal(await token("esm/auth.js"), "Bearer esm-2");
  assert.equal(trust.asked.length, before + 1);
  assert.match(trust.details.at(-1)!, /• node_modules\/esm-pkg\/part\.js \(changed\)/);
});

test("a failing script's error includes what it logged", async () => {
  await assert.rejects(run(".voiden-auth/fails.js"), /^Error: boom\nScript log:\n  step 1\n  step 2$/);
});

test("auth.log lines are returned", async () => {
  const result = await run(".voiden-auth/logs.js");
  assert.deepEqual(result.logs, ['hello {"n":1} 2']);
});

test("only the headers leave the script: results that can't be copied between threads are fine", async () => {
  assert.deepEqual((await run(".voiden-auth/odd-result.js")).headers, { Authorization: "Bearer tok" });
});

test("messages a script posts to the main thread itself are ignored", async () => {
  assert.equal(await token(".voiden-auth/noise.js"), "Bearer tok");
  assert.deepEqual(approvedLoads(".voiden-auth/noise.js"), []);
});

test("a script that isn't valid UTF-8 still runs", async () => {
  assert.equal(await token(".voiden-auth/latin1.js"), "Bearer tok");
});

test("scripts outside the project are refused, including through symlinks and ..", async () => {
  await assert.rejects(runScript({ ...req("x.js"), scriptPath: path.join(outside, "evil.js") }, project, deps()), /outside the project/);
  await assert.rejects(run(`../${path.basename(outside)}/evil.js`), /outside the project/);
  await assert.rejects(run("../missing/escape.js"), /not found/);
  // A directory link inside the project pointing outside it. "junction" works
  // on Windows without admin rights or Developer Mode; elsewhere it's an
  // ordinary directory symlink.
  symlinkSync(outside, path.join(project, "linked-dir"), "junction");
  await assert.rejects(run("linked-dir/evil.js"), /outside the project/);
  // A folder whose name merely starts with ".." is inside the project.
  assert.equal(await token("..hidden/a.js"), "Bearer hidden");
});

test("scripts in the project root, and folders given as scripts, are refused before anything is asked", async () => {
  const before = trust.asked.length;
  await assert.rejects(run("root.js"), /script root\.js is in the project root — move it into a folder, for example \.voiden-auth\/root\.js/);
  await assert.rejects(run(".voiden-auth/lib"), /script \.voiden-auth\/lib is not a file/);
  assert.equal(trust.asked.length, before);
});

test("missing, empty and result-less scripts give clear errors", async () => {
  await assert.rejects(run(".voiden-auth/missing.js"), /\.voiden-auth\/missing\.js not found/);
  await assert.rejects(run(".voiden-auth/empty.js"), /is empty/);
  await assert.rejects(run(".voiden-auth/nothing.js"), /returned nothing\nScript log:\n  no return/);
});

test("a script that runs too long is stopped — even one that never yields", async () => {
  await assert.rejects(
    run(".voiden-auth/slow.js", { timeoutMs: 100 }),
    /script \.voiden-auth\/slow\.js did not finish within 0\.1 s and was stopped/,
  );
  await sleep(600);
  assert.ok(!existsSync(path.join(project, "slow-finished.txt")), "the script didn't carry on after the timeout");

  const started = Date.now();
  await assert.rejects(run(".voiden-auth/hangs.js", { timeoutMs: 300 }), /hangs\.js did not finish within 0\.3 s and was stopped/);
  assert.ok(Date.now() - started < 3000);
});

test("process.exit() and uncaught errors end the script, not the app", async () => {
  await assert.rejects(run(".voiden-auth/exits.js"), /exits\.js exited before returning a result \(exit code 3\)/);
  await assert.rejects(run(".voiden-auth/throws-later.js"), /thrown later/);
});

test("problems filling in variables reach the script as errors", async () => {
  write(".voiden-auth/vars.js", "try { await auth.resolve('{{x}}'); } catch (e) { return { token: 'caught: ' + e.message }; }");
  const rejecting = async () => {
    throw new Error("no environment");
  };
  const throwing = (() => {
    throw new Error("thrown at once");
  }) as unknown as RunDeps["resolve"];
  assert.equal((await run(".voiden-auth/vars.js", { resolve: rejecting })).headers.Authorization, "caught: no environment");
  assert.equal((await run(".voiden-auth/vars.js", { resolve: throwing })).headers.Authorization, "caught: thrown at once");
});

test("isInside", () => {
  assert.ok(isInside("/p", "/p/a/b.js"));
  assert.ok(isInside("/p", "/p"));
  assert.ok(isInside("/p", "/p/..hidden/a.js"));
  assert.ok(!isInside("/p", "/p2/a.js"));
  assert.ok(!isInside("/p", "/p/../x.js"));
  assert.ok(!isInside("/p/a", "/p"));
});
