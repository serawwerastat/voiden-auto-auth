/**
 * The worker thread an auth script runs in.
 *
 * Each run gets a fresh worker, started by src/main/runScript.ts from this
 * file's bundled source. That gives the script
 *
 *   - its own thread, which the main thread can stop: a script that hangs or
 *     calls process.exit() ends this worker, not Voiden;
 *   - an empty module cache, so every file the script uses is loaded — and
 *     checked — in this run, and edited helpers are picked up without a
 *     restart.
 *
 * Every file loaded with require() is hashed as it is loaded and compared
 * with the user's approval (see `checkFile`), so what runs is what was
 * approved.
 *
 * The script is the body of an async function. It receives:
 *   auth                   the helper API (src/main/scriptApi.ts)
 *   require                resolving relative to the script, so
 *                          `require("./helpers")` and packages in the
 *                          project's node_modules work
 *   __filename, __dirname  of the script
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import { normalizeResult } from "../shared/result";
import type { FromWorker, ToWorker, WorkerInput } from "./messages";
import { voidenFetch } from "./network";
import { fileKey } from "./paths";
import { makeAuthApi } from "./scriptApi";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...params: string[]
) => (...args: unknown[]) => Promise<unknown>;

const input = workerData as WorkerInput;
const port = parentPort!;
const post = (message: FromWorker) => port.postMessage(message);

// ── Checking files as they are loaded ────────────────────────────────────────

const approved = new Map([...input.approved].map(([file, hash]) => [fileKey(file), hash]));

/**
 * Called for every file about to be loaded as code or data. Lets it through
 * when its content is what the approval holds. A file the approval doesn't
 * hold is accepted — and reported, to join the approval — only on a
 * learning run (see WorkerInput); otherwise the load fails, and the main
 * thread stops this worker and asks the user.
 */
function checkFile(file: string): void {
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  const key = fileKey(file);
  const expected = approved.get(key);
  if (expected === hash) return;
  if (expected === undefined && input.learning) {
    approved.set(key, hash);
    post({ type: "loaded", file, hash });
    return;
  }
  post({ type: "blocked", file, kind: expected === undefined ? "new" : "changed" });
  throw new Error(`${file} is not covered by your approval of this auth script`);
}

type Loader = (module: unknown, filename: string) => unknown;
type ModuleInternals = {
  /** require()'s loaders by file extension: .js, .json, .node. Every require() of a file goes through one. */
  _extensions: Record<string, Loader>;
  /** Hooks for require() and import alike; Node.js 22.15 and later. */
  registerHooks?(hooks: {
    load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown): unknown;
  }): unknown;
};
const internals = Module as unknown as ModuleInternals;

for (const [extension, load] of Object.entries(internals._extensions)) {
  internals._extensions[extension] = function (this: unknown, module: unknown, filename: string) {
    checkFile(filename);
    return load.call(this, module, filename);
  };
}
// Where Node.js has them, module hooks extend the check to ES modules:
// the files an ES module imports, and import() of a file.
internals.registerHooks?.({
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) checkFile(fileURLToPath(url));
    return nextLoad(url, context);
  },
});

// ── {{variables}} are filled in by the main thread ───────────────────────────

let lastId = 0;
const waiting = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
port.on("message", (message: ToWorker) => {
  const request = waiting.get(message?.id);
  if (!request) return;
  waiting.delete(message.id);
  if ("error" in message) request.reject(new Error(message.error));
  else request.resolve(message.value);
});
const resolveVariables = (text: string) =>
  new Promise<string>((resolve, reject) => {
    const id = ++lastId;
    waiting.set(id, { resolve, reject });
    post({ type: "resolve", id, text: String(text) });
  });

// ── Running the script ───────────────────────────────────────────────────────

async function run() {
  const api = makeAuthApi(input.run, {
    resolve: resolveVariables,
    // undici with Voiden's TLS and proxy settings, like Voiden's own requests.
    // (Not Electron's net.fetch: Chromium adds an Origin header, which
    // CORS-checking servers such as Spring reject with "Invalid CORS request".)
    fetch: voidenFetch(input.userDataDir),
    log: (line) => post({ type: "log", line }),
  });
  const script = new AsyncFunction("auth", "require", "__filename", "__dirname", input.code);
  const returned = await script(api, createRequire(input.scriptPath), input.scriptPath, path.dirname(input.scriptPath));
  return normalizeResult(returned, input.run.header);
}

run().then(
  (result) => post({ type: "done", result }),
  (e) => post({ type: "failed", error: e instanceof Error ? e.message : String(e) }),
);
