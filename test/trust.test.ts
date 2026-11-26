import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  diffHashes,
  ensureTrusted,
  hashFiles,
  hashFolder,
  preview,
  ReviewRequested,
  sha256,
  type Answer,
  type Change,
} from "../src/main/trust";
import { fakeTrust, tempDir } from "./helpers";

const hashes = (entries: Record<string, string>) => new Map(Object.entries(entries));

test("folder hashes cover every file except node_modules and .git", async () => {
  const dir = tempDir("auto-auth-fp-");
  mkdirSync(path.join(dir, "lib"));
  mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true });
  writeFileSync(path.join(dir, "a.js"), "1");
  writeFileSync(path.join(dir, "lib/b.js"), "2");
  writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "ignored");

  const first = await hashFolder(dir);
  assert.deepEqual(first, hashes({ "a.js": sha256("1"), "lib/b.js": sha256("2") }));

  writeFileSync(path.join(dir, "lib/b.js"), "3");
  writeFileSync(path.join(dir, "c.js"), "");
  rmSync(path.join(dir, "a.js"));
  assert.deepEqual(diffHashes(first, await hashFolder(dir)), [
    { path: "c.js", kind: "added" },
    { path: "lib/b.js", kind: "changed" },
    { path: "a.js", kind: "removed" },
  ]);
});

test("files named like object internals are hashed like any other", async () => {
  const dir = tempDir("auto-auth-proto-");
  for (const name of ["__proto__", "constructor", "toString"]) writeFileSync(path.join(dir, name), "v1");
  const first = await hashFolder(dir);
  assert.deepEqual([...first.keys()].sort(), ["__proto__", "constructor", "toString"]);

  writeFileSync(path.join(dir, "__proto__"), "v2");
  rmSync(path.join(dir, "constructor"));
  assert.deepEqual(diffHashes(first, await hashFolder(dir)), [
    { path: "__proto__", kind: "changed" },
    { path: "constructor", kind: "removed" },
  ]);
  assert.deepEqual(diffHashes(new Map(), hashes({ toString: "x" })), [{ path: "toString", kind: "added" }]);
});

test("a symbolic link is hashed as where it points and what is there", async (t) => {
  const dir = tempDir("auto-auth-link-");
  const elsewhere = tempDir("auto-auth-link-target-");
  writeFileSync(path.join(elsewhere, "good.js"), "good");
  writeFileSync(path.join(elsewhere, "other.js"), "good");
  mkdirSync(path.join(elsewhere, "folder"));
  try {
    symlinkSync(path.join(elsewhere, "good.js"), path.join(dir, "helper.js"), "file");
  } catch {
    return t.skip("creating file links needs extra rights on this system");
  }
  symlinkSync(path.join(elsewhere, "folder"), path.join(dir, "linked"), "junction");

  const first = await hashFolder(dir);
  assert.deepEqual([...first.keys()], ["helper.js", "linked"]);

  writeFileSync(path.join(elsewhere, "good.js"), "changed");
  assert.deepEqual(diffHashes(first, await hashFolder(dir)), [{ path: "helper.js", kind: "changed" }], "the target's content changed");

  writeFileSync(path.join(elsewhere, "good.js"), "good");
  rmSync(path.join(dir, "helper.js"));
  symlinkSync(path.join(elsewhere, "other.js"), path.join(dir, "helper.js"), "file");
  assert.deepEqual(diffHashes(first, await hashFolder(dir)), [{ path: "helper.js", kind: "changed" }], "same content, other target");
});

test("a folder with too many files is refused with advice", async () => {
  const dir = tempDir("auto-auth-big-");
  for (let i = 0; i <= 2000; i++) writeFileSync(path.join(dir, `f${i}`), "");
  await assert.rejects(hashFolder(dir), /more than 2000 files.*folder of their own, such as \.voiden-auth\//);
});

test("hashFiles leaves out files that are gone", async () => {
  const dir = tempDir("auto-auth-hf-");
  const kept = path.join(dir, "kept.js");
  writeFileSync(kept, "x");
  assert.deepEqual(await hashFiles([kept, path.join(dir, "gone.js")]), hashes({ [kept]: sha256("x") }));
});

test("preview shows the first lines, and is hard to mislead", () => {
  assert.equal(preview("a\r\nb\n"), "a\nb");
  const long = preview(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
  assert.equal(long.split("\n").length, 16);
  assert.match(long, /line 15\n… 25 more lines$/);
  assert.equal(preview("x".repeat(300)), `${"x".repeat(100)}…`);

  // JavaScript also ends a line at U+2028/U+2029, so code after one is on a line of its own.
  const separator = String.fromCharCode(0x2028);
  assert.equal(preview(`// just a comment${separator}stealSecrets();`), "// just a comment\nstealSecrets();");
  // Padding can't push code out of view, and control characters are shown.
  assert.equal(preview(`  ok();${" ".repeat(200)}stealSecrets();`), "  ok(); stealSecrets();");
  assert.equal(preview(`a${String.fromCharCode(0)}b${String.fromCharCode(8)}c`), `a${String.fromCharCode(0xfffd)}b${String.fromCharCode(0xfffd)}c`);
  assert.equal(preview(`${String.fromCharCode(0xfeff)}first`), "first", "a byte-order mark is not shown");
  // Other kinds of space pad no better, and invisible formatting characters are shown.
  for (const space of [0xa0, 0x3000, 0x2003]) {
    assert.equal(preview(`ok();${String.fromCharCode(space).repeat(200)}stealSecrets();`), "ok(); stealSecrets();");
  }
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const zeroWidthSpace = String.fromCharCode(0x200b);
  assert.equal(preview(`a${rightToLeftOverride}b${zeroWidthSpace}c`), `a${String.fromCharCode(0xfffd)}b${String.fromCharCode(0xfffd)}c`);
});

/** A project with a script, a helper next to it, and a helper elsewhere. */
function project() {
  const root = tempDir("auto-auth-trust-");
  mkdirSync(path.join(root, "auth/lib"), { recursive: true });
  mkdirSync(path.join(root, "shared"));
  const scriptPath = path.join(root, "auth/login.js");
  const code = "const token = await login();\nreturn { bearer: token };";
  writeFileSync(scriptPath, code);
  writeFileSync(path.join(root, "auth/lib/helper.js"), "1");
  writeFileSync(path.join(root, "shared/sign.js"), "1");

  let answer: Answer | (() => Answer) = "allow";
  const trust = fakeTrust(tempDir("auto-auth-store-"), () => (typeof answer === "function" ? answer() : answer));
  const check = (text = code, blocked: Change[] = []) =>
    ensureTrusted({ path: scriptPath, code: text, codeHash: sha256(text), projectRoot: root }, trust.deps, blocked);
  return { root, scriptPath, code, trust, check, answerWith: (a: typeof answer) => void (answer = a) };
}

test("the dialog shows the script; allowing is remembered until a covered file changes", async () => {
  const { root, scriptPath, code, trust, check, answerWith } = project();
  const outsideHelper = path.join(root, "shared/sign.js");

  const first = await check();
  assert.equal(first.learning, true, "the first run may load files the approval doesn't know yet");
  assert.deepEqual(
    [...first.files.keys()].sort(),
    [path.join(root, "auth/lib/helper.js"), scriptPath].sort(),
    "the approved files, by absolute path",
  );
  assert.equal(trust.asked.at(-1), "Run the auth script auth/login.js?");
  assert.match(trust.details.at(-1)!, /auth\/login\.js starts with:\n\nconst token = await login\(\);\nreturn \{ bearer: token \};/);
  assert.match(trust.details.at(-1)!, /full Node\.js access/);
  assert.match(trust.details.at(-1)!, /whatever it loads with require\(\) on this run/);
  assert.equal((await check()).learning, false);
  assert.equal(trust.asked.length, 1, "not asked again while nothing changed");

  // A helper in the folder changes.
  writeFileSync(path.join(root, "auth/lib/helper.js"), "2");
  assert.equal((await check()).learning, false, "allowing a change allows that change only");
  assert.match(trust.details.at(-1)!, /as they are now\. The script still can't load a file you haven't allowed/);
  assert.equal(trust.asked.length, 2);
  assert.match(trust.asked.at(-1)!, /or a file it uses, has changed since you allowed it/);
  assert.match(trust.details.at(-1)!, /Since you allowed it:\n  • auth\/lib\/helper\.js \(changed\)/);

  // A file the script loaded from elsewhere joins the approval, then changes.
  const learn = (learned: Map<string, string>) => trust.deps.store.addLearned(scriptPath, path.dirname(scriptPath), learned);
  await learn(await hashFiles([outsideHelper]));
  const withLoaded = await check();
  assert.equal(trust.asked.length, 2, "recording loaded files doesn't ask");
  assert.equal(withLoaded.files.get(outsideHelper), sha256("1"));
  writeFileSync(outsideHelper, "2");
  await check();
  assert.equal(trust.asked.length, 3);
  assert.match(trust.details.at(-1)!, /• shared\/sign\.js \(changed\)/);

  // A loaded file's approved hash is never replaced without a question.
  await learn(new Map([[outsideHelper, sha256("3")], [path.join(root, "auth/lib/helper.js"), sha256("3")]]));
  assert.equal((await check()).files.get(outsideHelper), sha256("2"));
  assert.equal(trust.asked.length, 3);

  // …or it disappears; once allowed again it's no longer watched.
  rmSync(outsideHelper);
  await check();
  assert.match(trust.details.at(-1)!, /• shared\/sign\.js \(removed\)/);
  await check();
  assert.equal(trust.asked.length, 4);

  // Declining and "Open script" both stop the run and store nothing.
  const edited = `${code}\n// edited`;
  writeFileSync(scriptPath, edited);
  answerWith("deny");
  await assert.rejects(check(edited), /running auth\/login\.js was not allowed/);
  answerWith("open");
  await assert.rejects(check(edited), (e) => e instanceof ReviewRequested && e.script === "auth/login.js");
  answerWith("allow");
  await check(edited);
  assert.equal(trust.asked.length, 7);

  // The text that was read must be the text that was hashed.
  await assert.rejects(check(code), /changed while it was being checked/);
});

test("a file the script was stopped at is asked about", async () => {
  const { root, scriptPath, trust, check } = project();
  await check();
  const result = await check(undefined, [{ path: path.join(root, "shared/new.js"), kind: "new" }]);
  assert.equal(result.learning, true, "the run that follows may load it");
  assert.equal(trust.asked.at(-1), "The auth script auth/login.js wants to load a file you haven't allowed yet. Run it?");
  assert.match(trust.details.at(-1)!, /Since you allowed it:\n  • shared\/new\.js \(not loaded before\)\n\n/);

  // A file stopped at because it changed is listed once, ahead of changes in the folder.
  const sign = path.join(root, "shared/sign.js");
  await trust.deps.store.addLearned(scriptPath, path.dirname(scriptPath), await hashFiles([sign]));
  writeFileSync(sign, "2");
  writeFileSync(path.join(root, "auth/lib/helper.js"), "2");
  assert.equal((await check(undefined, [{ path: sign, kind: "changed" }])).learning, false);
  assert.match(trust.details.at(-1)!, /Since you allowed it:\n  • shared\/sign\.js \(changed\)\n  • auth\/lib\/helper\.js \(changed\)\n\n/);
});

test("files a script loaded join the part of the approval they belong to", async () => {
  const { root, scriptPath, trust, check } = project();
  await check();
  const dir = path.dirname(scriptPath);
  writeFileSync(path.join(dir, "made-by-script.json"), "{}");
  mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "1");
  await trust.deps.store.addLearned(
    scriptPath,
    dir,
    await hashFiles([path.join(dir, "made-by-script.json"), path.join(dir, "node_modules/pkg/index.js"), path.join(root, "shared/sign.js")]),
  );
  const approval = (await trust.deps.store.get(scriptPath))!;
  assert.deepEqual([...approval.folder.keys()].sort(), ["lib/helper.js", "login.js", "made-by-script.json"]);
  assert.deepEqual([...approval.loaded.keys()].sort(), [path.join(dir, "node_modules/pkg/index.js"), path.join(root, "shared/sign.js")].sort());
  await check();
  assert.equal(trust.asked.length, 1, "a file the script made and loaded isn't a change");
});

test("files that change while the dialog is open are asked about again", async () => {
  const { root, trust, check, answerWith } = project();
  let edits = 0;
  answerWith(() => {
    // Someone edits a helper while the question is on screen — twice.
    if (edits < 2) writeFileSync(path.join(root, "auth/lib/helper.js"), `edit ${++edits}`);
    return "allow";
  });
  const result = await check();
  assert.equal(trust.asked.length, 3, "asked until what was shown is what is there");
  assert.equal(result.files.get(path.join(root, "auth/lib/helper.js")), sha256("edit 2"));

  // …but not forever.
  answerWith(() => {
    writeFileSync(path.join(root, "auth/lib/helper.js"), `edit ${++edits}`);
    return "allow";
  });
  writeFileSync(path.join(root, "auth/lib/helper.js"), "again");
  await assert.rejects(check(), /kept changing while you were asked/);
});

test("many changes are summarised", async () => {
  const { root, trust, check } = project();
  await check();
  for (let i = 0; i < 12; i++) writeFileSync(path.join(root, `auth/lib/new${i}.js`), "");
  await check();
  assert.equal(trust.details.at(-1)!.match(/•/g)!.length, 8);
  assert.match(trust.details.at(-1)!, /… and 4 more/);
});

test("approvals from before 1.2 (one fingerprint per script) are asked again; forgetting clears all", async () => {
  const root = tempDir("auto-auth-legacy-");
  mkdirSync(path.join(root, "auth"));
  const scriptPath = path.join(root, "auth/a.js");
  writeFileSync(scriptPath, "return 'a';");
  const storeDir = tempDir("auto-auth-store-");
  writeFileSync(path.join(storeDir, "trusted.json"), JSON.stringify({ [scriptPath]: "0123abcd" }));
  const trust = fakeTrust(storeDir);
  const check = () =>
    ensureTrusted({ path: scriptPath, code: "return 'a';", codeHash: sha256("return 'a';"), projectRoot: root }, trust.deps);

  await check();
  assert.equal(trust.asked.at(-1), "Run the auth script auth/a.js?");
  await check();
  assert.equal(trust.asked.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(storeDir, "trusted.json"), "utf8"))[scriptPath], {
    folder: { "a.js": sha256("return 'a';") },
    loaded: {},
  });

  await trust.deps.store.clear();
  await check();
  assert.equal(trust.asked.length, 2);
});

test("updates from scripts finishing together are all kept", async () => {
  const { store } = fakeTrust(tempDir("auto-auth-store-")).deps;
  const names = ["a", "b", "c", "d", "__proto__"];
  await Promise.all(names.map((name) => store.set(name, { folder: hashes({ [name]: "1" }), loaded: new Map() })));
  await Promise.all(names.map((name) => store.addLearned(name, path.resolve("/auth"), hashes({ [`/x/${name}`]: "2" }))));
  for (const name of names) {
    assert.deepEqual(await store.get(name), { folder: hashes({ [name]: "1" }), loaded: hashes({ [`/x/${name}`]: "2" }) });
  }
  await store.addLearned("never-approved", path.resolve("/auth"), hashes({ "/x": "1" }));
  assert.equal(await store.get("never-approved"), undefined);
});
