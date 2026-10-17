/**
 * Asking before running auth scripts — enforced in the main process, so
 * nothing in the renderer can skip it.
 *
 * Auth scripts run with full Node.js access and come from the project folder,
 * which may be someone else's repository. Before a script runs, the user
 * approves it. The approval covers a fingerprint of every file in the
 * script's folder (helpers it `require`s included, `node_modules` excluded):
 * when anything there changes — e.g. after a `git pull` — the user is asked
 * again.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const MAX_FILES = 2000;

/** SHA-256 over the relative paths and contents of every file under `dir`. */
export async function folderFingerprint(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
        if (files.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files in ${dir}`);
      }
    }
  };
  await walk(dir);
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(dir, file).replace(/\\/g, "/")).update("\0");
    hash.update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
}

/** Approved fingerprints, persisted as JSON: { "<script path>": "<fingerprint>" }. */
export class TrustStore {
  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) ?? {};
    } catch {
      return {};
    }
  }

  async get(scriptPath: string): Promise<string | undefined> {
    return (await this.load())[scriptPath];
  }

  async set(scriptPath: string, fingerprint: string): Promise<void> {
    const all = await this.load();
    all[scriptPath] = fingerprint;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2));
  }

  async clear(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, "{}");
  }
}

export interface TrustDeps {
  store: TrustStore;
  /** Shows the question; resolves true when the user allows. */
  ask(message: string, detail: string): Promise<boolean>;
}

/** Resolves when the script's folder, as it is now, is approved; throws when declined. */
export async function ensureTrusted(scriptPath: string, displayPath: string, deps: TrustDeps): Promise<void> {
  const fingerprint = await folderFingerprint(path.dirname(scriptPath));
  const approved = await deps.store.get(scriptPath);
  if (approved === fingerprint) return;

  const message = approved
    ? `The auth script ${displayPath} (or a file next to it) has changed since you allowed it. Run it?`
    : `Run the auth script ${displayPath}?`;
  const detail = [
    "Auth scripts run with full Node.js access: files, network and processes.",
    "Approving covers this script and every file in its folder, as they are now.",
    "Only allow scripts you have read or that come from people you trust.",
  ].join("\n\n");

  if (!(await deps.ask(message, detail))) throw new Error(`running ${displayPath} was not allowed`);
  await deps.store.set(scriptPath, fingerprint);
}
