/**
 * Running a user's auth script: checks where it is, asks for approval, runs
 * it in a worker thread (src/main/worker.ts) and returns the headers.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import workerSource from "virtual:script-worker";

import type { AuthResult, RunRequest } from "../shared/protocol";
import type { Resolve } from "./http";
import type { FromWorker, ToWorker, WorkerInput } from "./messages";
import { isInside } from "./paths";
import { Declined, ensureTrusted, hashFiles, sha256, type Change, type Hashes, type TrustDeps } from "./trust";

/** A script that runs longer than this is stopped (the request fails). */
export const SCRIPT_TIMEOUT_MS = 60_000;
/** How often a script is started in one request: again each time the user allowed a file it was stopped at. */
const MAX_RUNS = 3;

export interface RunDeps {
  resolve: Resolve;
  trust: TrustDeps;
  /** Voiden's user data folder; `auth.send` reads Voiden's network settings from it. */
  userDataDir: string;
  timeoutMs?: number;
}

interface WorkerOutcome {
  result?: Omit<AuthResult, "logs">;
  error?: string;
  /** The file the script was stopped at, because the approval doesn't cover it. */
  blocked?: Change;
  /** Files loaded that the approval didn't know yet (learning runs only), with their hashes. */
  learned: Hashes;
  logs: string[];
}

const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isFilePath = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value);

/** Runs the script in a fresh worker thread and stops the worker afterwards, whatever happened. */
function runInWorker(input: WorkerInput, name: string, resolve: Resolve, timeoutMs: number): Promise<WorkerOutcome> {
  return new Promise((settle) => {
    const logs: string[] = [];
    const learned: Hashes = new Map();
    const worker = new Worker(workerSource, { eval: true, workerData: input });
    let finished = false;
    const finish = (outcome: Pick<WorkerOutcome, "result" | "error" | "blocked">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      settle({ ...outcome, learned, logs });
    };

    const timer = setTimeout(
      () => finish({ error: `script ${name} did not finish within ${timeoutMs / 1000} s and was stopped` }),
      timeoutMs,
    );

    const answerResolve = (id: number, text: unknown) => {
      const reply = (answer: { value: string } | { error: string }) => {
        if (!finished) worker.postMessage({ type: "resolved", id, ...answer } satisfies ToWorker);
      };
      Promise.resolve()
        .then(() => resolve(String(text)))
        .then(
          (value) => reply({ value: String(value) }),
          (e) => reply({ error: e instanceof Error ? e.message : String(e) }),
        );
    };

    // The script shares the worker and could post anything: take nothing on trust.
    worker.on("message", (message: FromWorker | null) => {
      if (finished || !message || typeof message !== "object") return;
      switch (message.type) {
        case "resolve":
          if (typeof message.id === "number") answerResolve(message.id, message.text);
          break;
        case "log":
          logs.push(String(message.line));
          break;
        case "loaded":
          if (isFilePath(message.file) && isHash(message.hash)) learned.set(message.file, message.hash);
          break;
        case "blocked":
          if (isFilePath(message.file)) {
            finish({ blocked: { path: message.file, kind: message.kind === "changed" ? "changed" : "new" } });
          }
          break;
        case "done":
          finish({ result: message.result });
          break;
        case "failed":
          finish({ error: String(message.error) });
          break;
      }
    });
    // An error nothing in the script caught, e.g. thrown from a timer callback.
    worker.on("error", (e) => finish({ error: e instanceof Error ? e.message : String(e) }));
    worker.on("exit", (code) => finish({ error: `script ${name} exited before returning a result (exit code ${code})` }));
  });
}

/**
 * Runs of the same script take turns, so that parallel requests are asked
 * once, and a run never starts while another is still adding files to the
 * script's approval. When the user declines, the runs that were waiting
 * behind that question are declined with it rather than each asking again.
 */
interface Turns {
  last: Promise<unknown>;
  waiting: Set<{ declined?: Declined }>;
}
const turnsByScript = new Map<string, Turns>();

function inTurn<T>(scriptPath: string, task: () => Promise<T>): Promise<T> {
  const turns = turnsByScript.get(scriptPath) ?? { last: Promise.resolve(), waiting: new Set() };
  turnsByScript.set(scriptPath, turns);
  const mine: { declined?: Declined } = {};
  turns.waiting.add(mine);

  const result = turns.last.then(async () => {
    turns.waiting.delete(mine);
    if (mine.declined) throw mine.declined;
    try {
      return await task();
    } catch (e) {
      if (e instanceof Declined) for (const other of turns.waiting) other.declined = e;
      throw e;
    }
  });
  const settled = result.catch(() => {});
  turns.last = settled;
  void settled.then(() => {
    if (turns.last === settled) turnsByScript.delete(scriptPath);
  });
  return result;
}

/** The package.json of the package a file in node_modules belongs to, if any. */
async function packageJsonOf(file: string): Promise<string | undefined> {
  const marker = `${path.sep}node_modules${path.sep}`;
  for (let dir = path.dirname(file); dir.includes(marker); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (await stat(candidate).then((s) => s.isFile(), () => false)) return candidate;
  }
  return undefined;
}

/**
 * What a learning run adds to the approval: the files it loaded, with the
 * hashes of what was loaded, plus the package.json of each package among
 * them — it decides which of a package's files a require() loads.
 */
async function withPackageFiles(learned: Hashes): Promise<Hashes> {
  const packageFiles = new Set<string>();
  for (const file of learned.keys()) {
    const packageJson = await packageJsonOf(file);
    if (packageJson && !learned.has(packageJson)) packageFiles.add(packageJson);
  }
  return new Map([...learned, ...(await hashFiles(packageFiles))]);
}

export function runScript(req: RunRequest, projectPath: string, deps: RunDeps): Promise<AuthResult> {
  // Queue by the path as given; the real path is found inside the turn.
  return inTurn(path.resolve(req.scriptPath), () => checkAndRun(req, projectPath, deps));
}

async function checkAndRun(req: RunRequest, projectPath: string, deps: RunDeps): Promise<AuthResult> {
  const asWritten = path.relative(projectPath, path.resolve(req.scriptPath)).replace(/\\/g, "/");

  let root: string;
  let scriptPath: string;
  try {
    root = await realpath(projectPath);
    scriptPath = await realpath(path.resolve(req.scriptPath));
  } catch {
    throw new Error(`script ${asWritten} not found`);
  }
  // realpath resolves symlinks, so a link inside the project can't point outside it.
  if (!isInside(root, scriptPath)) throw new Error(`script ${asWritten} is outside the project`);

  const shown = path.relative(root, scriptPath).replace(/\\/g, "/");
  if (!(await stat(scriptPath)).isFile()) throw new Error(`script ${shown} is not a file`);
  // Approval covers the script's whole folder, which must not be the whole project.
  if (path.dirname(scriptPath) === root) {
    throw new Error(`script ${shown} is in the project root — move it into a folder, for example .voiden-auth/${shown}`);
  }

  // Read once: these bytes are hashed for the approval, and their text is what runs.
  const bytes = await readFile(scriptPath);
  const code = bytes.toString("utf8");
  if (!code.trim()) throw new Error(`script ${shown} is empty`);
  const script = { path: scriptPath, code, codeHash: sha256(bytes), projectRoot: root };

  const dir = path.dirname(scriptPath);
  let blocked: Change | undefined;
  for (let attempt = 0; attempt < MAX_RUNS; attempt++) {
    const trusted = await ensureTrusted(script, deps.trust, blocked ? [blocked] : []);

    const input: WorkerInput = {
      scriptPath,
      code,
      run: { service: req.service, header: req.header, request: req.request },
      userDataDir: deps.userDataDir,
      approved: trusted.files,
      learning: trusted.learning,
    };
    const outcome = await runInWorker(input, shown, deps.resolve, deps.timeoutMs ?? SCRIPT_TIMEOUT_MS);
    // Files this run loaded for the first time join the approval, with the
    // hash of the content that was loaded: from now on they must stay as they are.
    if (outcome.learned.size) await deps.trust.store.addLearned(scriptPath, dir, await withPackageFiles(outcome.learned));

    if (outcome.result) return { ...outcome.result, logs: outcome.logs };
    if (outcome.blocked) {
      // Stopped before a file the approval doesn't cover. If it is the file
      // the user allowed a moment ago, it changes on every run and asking again can't help.
      if (blocked?.path === outcome.blocked.path && outcome.blocked.kind === "changed") {
        const file = isInside(root, blocked.path) ? path.relative(root, blocked.path).replace(/\\/g, "/") : blocked.path;
        throw new Error(
          `${file} is different every time ${shown} runs, so it can't be approved. If the script writes this file itself, read it with fs instead of require()`,
        );
      }
      // Otherwise ask about it, then start the script over.
      blocked = outcome.blocked;
      continue;
    }
    // Include what the script logged, so failures can be understood from the error alone.
    const tail = outcome.logs.slice(-5);
    const message = outcome.error ?? "the script failed";
    throw new Error(tail.length ? `${message}\nScript log:\n${tail.map((l) => `  ${l}`).join("\n")}` : message);
  }
  throw new Error(`files loaded by ${shown} kept changing — send the request again`);
}
