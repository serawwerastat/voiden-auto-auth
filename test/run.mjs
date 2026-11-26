#!/usr/bin/env node
/**
 * Compiles test/*.test.ts with esbuild and runs them with Node's built-in
 * test runner (`node --test`). No test framework needed.
 */
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { workerSource } from "../build/workerSource.mjs";

const outdir = ".test-build";
rmSync(outdir, { recursive: true, force: true });

const entryPoints = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  outExtension: { ".js": ".mjs" },
  // React is supplied by Voiden at runtime; tests load components but never
  // render them, so a stub is enough.
  alias: { react: "./test/stubs/react.ts", "react/jsx-runtime": "./test/stubs/react.ts" },
  plugins: [workerSource],
  // Tests that import the network code directly load undici from node_modules
  // (in the release it's bundled into the script worker, as it is here for
  // tests that run scripts).
  external: ["undici"],
  logLevel: "warning",
});

const compiled = entryPoints.map((e) => `${outdir}/${e.slice("test/".length).replace(/\.ts$/, ".mjs")}`);
// The suite takes seconds. If it hasn't ended after minutes, something a test
// started is still alive (a script worker that wasn't stopped, an open server).
const TIMEOUT_MS = 3 * 60_000;
const result = spawnSync(process.execPath, ["--test", ...compiled], { stdio: "inherit", timeout: TIMEOUT_MS });
if (result.error?.code === "ETIMEDOUT") {
  console.error(`\nThe tests did not end within ${TIMEOUT_MS / 60_000} minutes: something they started is still running.`);
}
process.exit(result.status ?? 1);
