#!/usr/bin/env node
/**
 * Compiles test/*.test.ts with esbuild and runs them with Node's built-in
 * test runner (`node --test`). No test framework needed.
 */
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
  logLevel: "warning",
});

const compiled = entryPoints.map((e) => `${outdir}/${e.slice("test/".length).replace(/\.ts$/, ".mjs")}`);
const result = spawnSync(process.execPath, ["--test", ...compiled], { stdio: "inherit" });
process.exit(result.status ?? 1);
