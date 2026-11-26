/**
 * What the main thread and the script worker (src/main/worker.ts) exchange.
 */

import type { AuthResult, RunRequest } from "../shared/protocol";

/** Passed to the worker when it starts. */
export interface WorkerInput {
  /** Real, absolute path of the script. */
  scriptPath: string;
  /** The script's text — the text that was approved. */
  code: string;
  run: Pick<RunRequest, "service" | "header" | "request">;
  /** Voiden's user data folder, where its network settings are stored. */
  userDataDir: string;
  /** SHA-256 by absolute path of every file the approval covers. */
  approved: Map<string, string>;
  /**
   * True on a script's first run after it was allowed, and after the user
   * allowed a file it was stopped at: files it loads that the approval
   * doesn't hold yet are accepted and reported, to be added to it. On every
   * other run such a file stops the script.
   */
  learning: boolean;
}

export type FromWorker =
  /** Fill in {{variables}}: only the main thread can ask Voiden. */
  | { type: "resolve"; id: number; text: string }
  | { type: "log"; line: string }
  /** A file was loaded that the approval didn't know (learning runs only). */
  | { type: "loaded"; file: string; hash: string }
  /** The script tried to load a file the approval doesn't cover; nothing of it ran. */
  | { type: "blocked"; file: string; kind: "new" | "changed" }
  | { type: "done"; result: Omit<AuthResult, "logs"> }
  | { type: "failed"; error: string };

export type ToWorker = { type: "resolved"; id: number; value: string } | { type: "resolved"; id: number; error: string };
