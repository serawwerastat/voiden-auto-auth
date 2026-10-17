/**
 * Running a user's auth script in Node.js (Voiden's main process).
 *
 * The script is the body of an async function. It receives:
 *   auth                   the helper API below
 *   require                resolving relative to the script, so
 *                          `require("./helpers")` and packages in the
 *                          project's node_modules work
 *   __filename, __dirname  of the script
 * Whatever the script returns is normalised by `normalizeResult`.
 */

import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { jwtExpiry, normalizeResult } from "../shared/result";
import type { AuthResult, RunRequest } from "../shared/protocol";
import { send, type Fetch, type Resolve, type SendOptions } from "./http";
import { ensureTrusted, type TrustDeps } from "./trust";

/** A script that runs longer than this is abandoned (the request fails). */
export const SCRIPT_TIMEOUT_MS = 60_000;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...params: string[]
) => (...args: unknown[]) => Promise<unknown>;

export interface AuthApi {
  /** Name of the service in the auth config. */
  service: string;
  /** The request being authorized. */
  request: RunRequest["request"];
  send(options: SendOptions): ReturnType<typeof send>;
  /** Value of an environment variable, or undefined when it isn't set. */
  env(name: string): Promise<string | undefined>;
  /** Fill in {{variables}} in any text. */
  resolve(text: string): Promise<string>;
  base64(text: string): string;
  jwtExpiry(token: string): number | null;
  log(...args: unknown[]): void;
}

export interface RunDeps {
  resolve: Resolve;
  fetch: Fetch;
  trust: TrustDeps;
  /** Receives each auth.log() line. */
  log?: (line: string) => void;
  timeoutMs?: number;
}

const formatLogArg = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** True when `child` is `parent` or inside it. Both should be real (symlink-free) paths. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function makeAuthApi(req: RunRequest, deps: Pick<RunDeps, "resolve" | "fetch" | "log">): AuthApi {
  return {
    service: req.service,
    request: req.request,
    send: (options) => send(options, deps.resolve, deps.fetch),
    env: async (name) => {
      const placeholder = `{{${name}}}`;
      const value = await deps.resolve(placeholder);
      return value === placeholder ? undefined : value;
    },
    resolve: deps.resolve,
    base64: (text) => Buffer.from(String(text), "utf8").toString("base64"),
    jwtExpiry,
    log: (...args) => deps.log?.(args.map(formatLogArg).join(" ")),
  };
}

/** Forget cached modules from the script's folder, so edited helpers are picked up. */
function clearRequireCache(dir: string): void {
  const require = createRequire(path.join(dir, "noop.js"));
  for (const key of Object.keys(require.cache)) {
    if (isInside(dir, key) && !key.includes(`${path.sep}node_modules${path.sep}`)) delete require.cache[key];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runScript(req: RunRequest, projectPath: string, deps: RunDeps): Promise<AuthResult> {
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
  const code = await readFile(scriptPath, "utf8");
  if (!code.trim()) throw new Error(`script ${shown} is empty`);

  await ensureTrusted(scriptPath, shown, deps.trust);
  clearRequireCache(path.dirname(scriptPath));

  const logs: string[] = [];
  const api = makeAuthApi(req, { ...deps, log: (line) => (logs.push(line), deps.log?.(line)) });
  const fn = new AsyncFunction("auth", "require", "__filename", "__dirname", code);
  const result = await withTimeout(
    fn(api, createRequire(scriptPath), scriptPath, path.dirname(scriptPath)),
    deps.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    `script ${shown}`,
  );
  return { ...normalizeResult(result, req.header), logs };
}
