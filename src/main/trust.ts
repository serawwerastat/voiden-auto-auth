/**
 * Asking before running auth scripts — enforced in the main process, so
 * nothing in the renderer can skip it.
 *
 * Auth scripts run with full Node.js access and come from the project folder,
 * which may be someone else's repository. Before a script runs, the user
 * approves it. An approval records a SHA-256 hash of
 *
 *   - every file in the script's folder (`node_modules` and `.git` excluded), and
 *   - every other file the script loaded with `require()` on its first run —
 *     helpers elsewhere in the project, packages in `node_modules`.
 *
 * Before each run, all of them are compared with the files as they are now;
 * when one has changed, appeared or disappeared — e.g. after a `git pull` or
 * an `npm install` — the user is asked again, and told which. During the run,
 * the worker (src/main/worker.ts) checks every file at the moment it is
 * loaded, against the same hashes, and stops at a file they don't hold.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, readlink, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { isInside } from "./paths";

const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const MAX_FOLDER_FILES = 2000;
/** Lines of the script shown in the approval dialog. */
const PREVIEW_LINES = 15;
const PREVIEW_LINE_LENGTH = 100;
/** Control characters (other than tab) and invisible formatting characters, which could hide what a line does. */
const HIDDEN_CHARACTERS = new RegExp("[\\x00-\\x08\\x0B-\\x1F\\x7F\\p{Cf}]", "gu");
/** Changed files listed in the approval dialog. */
const LISTED_CHANGES = 8;
/** How often the user is asked again when files change while they are being asked. */
const MAX_QUESTIONS = 3;

/** SHA-256 by file path. (A Map: file names such as `__proto__` are ordinary keys.) */
export type Hashes = Map<string, string>;

export interface Approval {
  /** Files in the script's folder, by path relative to that folder (forward slashes). */
  folder: Hashes;
  /** Files outside it that the script loaded with require(), by absolute path. */
  loaded: Hashes;
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * Hashes of every file under `dir`, keyed by path relative to it.
 *
 * A symbolic link is hashed as where it points plus, when that is a file, the
 * file's content; linked folders are not walked (what a script loads from
 * them is checked when it is loaded).
 */
export async function hashFolder(dir: string): Promise<Hashes> {
  const entries: { file: string; link: boolean }[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        entries.push({ file: full, link: entry.isSymbolicLink() });
        if (entries.length > MAX_FOLDER_FILES) {
          throw new Error(
            `the script's folder has more than ${MAX_FOLDER_FILES} files. Approving a script covers every file in its folder, so keep auth scripts in a folder of their own, such as .voiden-auth/`,
          );
        }
      }
    }
  };
  await walk(dir);

  const hashes: Hashes = new Map();
  for (const { file, link } of entries.sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const hash = createHash("sha256");
    if (link) hash.update(`symlink ${await readlink(file).catch(() => "?")}\n`);
    try {
      hash.update(await readFile(file));
    } catch (e) {
      if (!link) throw e; // a link to a folder, or to nothing: only where it points counts
    }
    hashes.set(path.relative(dir, file).replace(/\\/g, "/"), hash.digest("hex"));
  }
  return hashes;
}

/** `file` as `hashFolder(dir)` keys it, or undefined when that walk doesn't reach it. */
export function folderKey(dir: string, file: string): string | undefined {
  if (!isInside(dir, file) || file === dir) return undefined;
  const parts = path.relative(dir, file).split(path.sep);
  return parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part)) ? undefined : parts.join("/");
}

/** Hashes of the given files, keyed as given. Files that can't be read are left out. */
export async function hashFiles(files: Iterable<string>): Promise<Hashes> {
  const hashes: Hashes = new Map();
  for (const file of files) {
    try {
      hashes.set(file, sha256(await readFile(file)));
    } catch {
      // Gone or unreadable: reported as removed when compared with an approval.
    }
  }
  return hashes;
}

export interface Change {
  path: string;
  /** `new`: a file the script wants to load that it hasn't loaded since it was allowed. */
  kind: "changed" | "added" | "removed" | "new";
}

/** What differs between the approved hashes and the current ones. */
export function diffHashes(approved: Hashes, current: Hashes): Change[] {
  const changes: Change[] = [];
  for (const [file, hash] of current) {
    if (!approved.has(file)) changes.push({ path: file, kind: "added" });
    else if (approved.get(file) !== hash) changes.push({ path: file, kind: "changed" });
  }
  for (const file of approved.keys()) {
    if (!current.has(file)) changes.push({ path: file, kind: "removed" });
  }
  return changes;
}

const sameHashes = (a: Hashes, b: Hashes): boolean => a.size === b.size && diffHashes(a, b).length === 0;

type StoredHashes = Record<string, string>;
type StoredApproval = { folder: StoredHashes; loaded?: StoredHashes };

/**
 * An approval as stored. Entries written before version 1.2 were a single
 * fingerprint string; they count as not approved, so the user is asked once more.
 */
function readApproval(entry: unknown): Approval | undefined {
  const stored = entry as Partial<StoredApproval> | string | null | undefined;
  if (!stored || typeof stored !== "object" || !stored.folder || typeof stored.folder !== "object") return undefined;
  const hashes = (record: StoredHashes | undefined): Hashes =>
    new Map(Object.entries(record ?? {}).filter(([, hash]) => typeof hash === "string"));
  return { folder: hashes(stored.folder), loaded: hashes(stored.loaded) };
}

const storeApproval = (approval: Approval): StoredApproval => ({
  folder: Object.fromEntries(approval.folder),
  loaded: Object.fromEntries(approval.loaded),
});

/** Approvals, persisted as JSON: { "<script path>": { folder, loaded } }. */
export class TrustStore {
  /** Serialises updates, so two scripts finishing together don't overwrite each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<Map<string, unknown>> {
    try {
      const all = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      return new Map(all && typeof all === "object" ? Object.entries(all) : []);
    } catch {
      return new Map();
    }
  }

  private update(change: (all: Map<string, unknown>) => boolean): Promise<void> {
    const next = this.queue.then(async () => {
      const all = await this.load();
      if (!change(all)) return;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(Object.fromEntries(all), null, 2));
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async get(scriptPath: string): Promise<Approval | undefined> {
    await this.queue;
    return readApproval((await this.load()).get(scriptPath));
  }

  set(scriptPath: string, approval: Approval): Promise<void> {
    return this.update((all) => {
      all.set(scriptPath, storeApproval(approval));
      return true;
    });
  }

  /**
   * Adds files the script loaded (by absolute path) to its approval, if it
   * (still) has one: files of the script's folder `dir` to the folder part,
   * others to the loaded part. Files already in the approval keep their
   * approved hash.
   */
  addLearned(scriptPath: string, dir: string, learned: Hashes): Promise<void> {
    return this.update((all) => {
      const approval = readApproval(all.get(scriptPath));
      if (!approval) return false;
      for (const [file, hash] of learned) {
        const inFolder = folderKey(dir, file);
        const [part, key] = inFolder === undefined ? [approval.loaded, file] : [approval.folder, inFolder];
        if (!part.has(key)) part.set(key, hash);
      }
      all.set(scriptPath, storeApproval(approval));
      return true;
    });
  }

  clear(): Promise<void> {
    return this.update((all) => {
      all.clear();
      return true;
    });
  }
}

/** What the user can answer: run it, look at it first, or don't run it. */
export type Answer = "allow" | "open" | "deny";

export interface TrustDeps {
  store: TrustStore;
  ask(message: string, detail: string): Promise<Answer>;
}

/** The user didn't allow the script. */
export class Declined extends Error {}

/** The user chose to look at the script instead of allowing it. */
export class ReviewRequested extends Declined {
  constructor(readonly script: string) {
    super(`${script} was opened for review`);
  }
}

/**
 * The first lines of a script, for the approval dialog. Lines end where
 * JavaScript ends them, runs of spaces (of any kind) inside a line are
 * shortened, and control and invisible formatting characters are shown as a
 * replacement character, so the preview is hard to mislead; it is still
 * only the beginning of the script.
 */
export function preview(code: string): string {
  const lines = code
    .replace(/^\uFEFF/, "")
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const shown = lines.slice(0, PREVIEW_LINES).map((line) => {
    const indent = /^[ \t]*/.exec(line)![0];
    const text = line
      .slice(indent.length)
      .replace(/[\s\p{Zs}]{2,}/gu, " ")
      .replace(HIDDEN_CHARACTERS, "\uFFFD");
    const fitted = indent.replace(/\t/g, "  ") + text;
    return fitted.length > PREVIEW_LINE_LENGTH ? `${fitted.slice(0, PREVIEW_LINE_LENGTH)}…` : fitted;
  });
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`… ${rest} more line${rest > 1 ? "s" : ""}`);
  return shown.join("\n");
}

const KIND_LABELS: Record<Change["kind"], string> = {
  changed: "changed",
  added: "added",
  removed: "removed",
  new: "not loaded before",
};

function listChanges(changes: Change[]): string {
  const lines = changes.slice(0, LISTED_CHANGES).map((c) => `  • ${c.path} (${KIND_LABELS[c.kind]})`);
  if (changes.length > LISTED_CHANGES) lines.push(`  … and ${changes.length - LISTED_CHANGES} more`);
  return lines.join("\n");
}

export interface ScriptToTrust {
  /** Real, absolute path of the script. */
  path: string;
  /** The script's text, as it is about to be run, and the hash of the file it was read from. */
  code: string;
  codeHash: string;
  /** Real path of the project; changed files are named relative to it. */
  projectRoot: string;
}

export interface Trusted {
  /** Hash by absolute path of every file the approval covers. */
  files: Hashes;
  /**
   * True when the run that follows may load files the approval doesn't know
   * yet, which then join it: on the first approval, and after the user
   * allowed a file the script was stopped at. Every other run is strict — a
   * question about changed files allows those changes and nothing else.
   */
  learning: boolean;
}

/**
 * Resolves with the approved files once the script, its folder and the files
 * it has loaded are approved as they are now; asks the user when they
 * aren't. Throws when the user declines, or `ReviewRequested` when they want
 * to read the script first.
 *
 * `blocked` are files (absolute paths) the script tried to load in a run
 * that was stopped because the approval didn't cover them; the user is
 * asked about those.
 */
export async function ensureTrusted(script: ScriptToTrust, deps: TrustDeps, blocked: Change[] = []): Promise<Trusted> {
  const dir = path.dirname(script.path);
  const display = (absolute: string): string =>
    isInside(script.projectRoot, absolute) ? path.relative(script.projectRoot, absolute).replace(/\\/g, "/") : absolute;
  const shown = display(script.path);

  const current = async (approved: Approval | undefined): Promise<Approval> => {
    const folder = await hashFolder(dir);
    // What was hashed must be what will run.
    if (folder.get(path.basename(script.path)) !== script.codeHash) {
      throw new Error(`${shown} changed while it was being checked — send the request again`);
    }
    return { folder, loaded: approved ? await hashFiles(approved.loaded.keys()) : new Map() };
  };
  const trusted = (approval: Approval, learning: boolean): Trusted => ({
    files: new Map([...[...approval.folder].map(([file, hash]) => [path.join(dir, file), hash] as const), ...approval.loaded]),
    learning,
  });

  for (let question = 0; question < MAX_QUESTIONS; question++) {
    const approved = await deps.store.get(script.path);
    const now = await current(approved);
    // Files the script loads from elsewhere first: they are the ones a reader of its folder doesn't see.
    const found: Change[] = approved
      ? [
          ...blocked,
          ...diffHashes(approved.loaded, now.loaded),
          ...diffHashes(approved.folder, now.folder).map((c) => ({ ...c, path: path.join(dir, c.path) })),
        ]
      : [];
    const changes = found
      .filter((change, i) => found.findIndex((other) => other.path === change.path) === i)
      .map((change) => ({ ...change, path: display(change.path) }));
    if (approved && changes.length === 0) return trusted(approved, false);

    const learning = !approved || changes.some((c) => c.kind === "new");
    const message = !approved
      ? `Run the auth script ${shown}?`
      : changes.every((c) => c.kind === "new")
        ? `The auth script ${shown} wants to load a file you haven't allowed yet. Run it?`
        : `The auth script ${shown}, or a file it uses, has changed since you allowed it. Run it?`;
    const detail = [
      ...(changes.length ? [`Since you allowed it:\n${listChanges(changes)}`] : []),
      `${shown} starts with:\n\n${preview(script.code)}`,
      "Auth scripts run with full Node.js access: files, network and processes.",
      learning
        ? "Allowing covers this script, every file in its folder, and whatever it loads with require() on this run. After that it can only load those files, unchanged — otherwise you're asked again."
        : "Allowing covers these files as they are now. The script still can't load a file you haven't allowed.",
      "Only allow scripts you have read or that come from people you trust.",
    ].join("\n\n");

    const answer = await deps.ask(message, detail);
    if (answer === "open") throw new ReviewRequested(shown);
    if (answer !== "allow") throw new Declined(`running ${shown} was not allowed`);

    // What is stored must be what the question was about: if a file changed
    // while the dialog was open, ask again.
    const after = await current(approved);
    if (sameHashes(now.folder, after.folder) && sameHashes(now.loaded, after.loaded)) {
      await deps.store.set(script.path, now);
      return trusted(now, learning);
    }
  }
  throw new Error(`files used by ${shown} kept changing while you were asked — send the request again`);
}
