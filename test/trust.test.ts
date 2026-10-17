import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { folderFingerprint } from "../src/main/trust";
import { tempDir } from "./helpers";

test("the fingerprint covers every file in the folder except node_modules and .git", async () => {
  const dir = tempDir("auto-auth-fp-");
  mkdirSync(path.join(dir, "lib"));
  mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true });
  writeFileSync(path.join(dir, "a.js"), "1");
  writeFileSync(path.join(dir, "lib/b.js"), "2");

  const first = await folderFingerprint(dir);
  writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "ignored");
  assert.equal(await folderFingerprint(dir), first, "node_modules is ignored");

  writeFileSync(path.join(dir, "lib/b.js"), "3");
  assert.notEqual(await folderFingerprint(dir), first, "a helper change is detected");

  writeFileSync(path.join(dir, "lib/b.js"), "2");
  assert.equal(await folderFingerprint(dir), first, "same content, same fingerprint");

  writeFileSync(path.join(dir, "c.js"), "");
  assert.notEqual(await folderFingerprint(dir), first, "a new file is detected");
});
