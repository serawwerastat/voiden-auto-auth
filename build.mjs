#!/usr/bin/env node
/**
 * Builds the two bundles Voiden loads:
 *   dist/<id>.js        renderer part (ES module) — hooks, status bar, commands
 *   dist/<id>-main.cjs  main-process part (Node.js) — runs the auth scripts
 *
 * Voiden provides React and a few other libraries to plugins at runtime on
 * `window.__voiden_shims__`, so the plugin must use those shared instances
 * instead of bundling its own copies. Imports of these modules are redirected
 * to the host object below — the same approach as the official
 * @voiden/create-plugin template.
 *
 * Note: Voiden's installer rewrites every quoted "react" / "react-dom" /
 * "react/jsx-runtime" string in a community plugin to a shim-file path. The
 * lookup keys are therefore assembled at runtime so no such literal ends up
 * in the bundle.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const HOST_MODULES = ["react", "react/jsx-runtime", "react-dom", "lucide-react", "yaml"];

const hostModules = {
  name: "voiden-host-modules",
  setup(b) {
    const filter = new RegExp(`^(${HOST_MODULES.map((m) => m.replace(/[/]/g, "\\/")).join("|")})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "voiden-host" }));
    b.onLoad({ filter: /.*/, namespace: "voiden-host" }, (args) => ({
      loader: "js",
      contents: [
        `const key = ${JSON.stringify([...args.path])}.join("");`,
        `const mod = (window.__voiden_shims__ || {})[key];`,
        `if (!mod) throw new Error("Voiden did not provide host module " + key);`,
        `module.exports = mod;`,
      ].join("\n"),
    }));
  },
};

const banner = [
  // Bundle format version Voiden checks before loading a plugin.
  `globalThis["__voiden_bundle_version__"] = 2;`,
  `export const __voiden_bundle_version__ = 2;`,
  `export const __voiden_manifest__ = ${JSON.stringify(manifest)};`,
].join("\n");

await build({
  entryPoints: ["src/plugin.ts"],
  outfile: `dist/${manifest.id}.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  plugins: [hostModules],
  banner: { js: banner },
  legalComments: "none",
  logLevel: "info",
});

await build({
  entryPoints: ["src/main-process.ts"],
  outfile: `dist/${manifest.id}-main.cjs`,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["electron"],
  legalComments: "none",
  logLevel: "info",
});

// Guard against the installer rewrite described above.
const out = readFileSync(`dist/${manifest.id}.js`, "utf8");
const rewritten = /["'](react|react-dom|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom\/client|@voiden\/sdk|@voiden\/sdk\/ui)["']/.exec(out);
if (rewritten) {
  console.error(`\n  Bundle contains the literal ${rewritten[0]}, which Voiden's installer would rewrite. Build the key at runtime instead.\n`);
  process.exit(1);
}
