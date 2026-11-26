/**
 * esbuild plugin for `import source from "virtual:script-worker"`.
 *
 * Auth scripts run in worker threads (src/main/worker.ts). Voiden loads a
 * plugin's main-process part as one file, so the worker can't be a file of
 * its own: it is bundled separately here — together with undici, the HTTP
 * client behind auth.send — and handed to the main bundle as a string, which
 * the script runner starts workers from (`new Worker(source, { eval: true })`).
 */
import { build } from "esbuild";

export const workerSource = {
  name: "script-worker-source",
  setup(b) {
    b.onResolve({ filter: /^virtual:script-worker$/ }, (args) => ({ path: args.path, namespace: "script-worker" }));
    b.onLoad({ filter: /.*/, namespace: "script-worker" }, async () => {
      const result = await build({
        entryPoints: ["src/main/worker.ts"],
        bundle: true,
        write: false,
        format: "cjs",
        platform: "node",
        target: "node18",
        minify: true, // mostly undici, including its embedded HTTP parser
        legalComments: "none",
        logLevel: "warning",
      });
      return { loader: "js", contents: `export default ${JSON.stringify(result.outputFiles[0].text)};` };
    });
  },
};
