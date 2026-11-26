/** Shared test helpers for the main-process side. */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TrustStore, type Answer, type TrustDeps } from "../src/main/trust";

/** A new temporary folder (its real path, as macOS's /tmp is a symlink). */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Trust deps that record each question and answer with `answer()`. */
export function fakeTrust(dir: string, answer: () => Answer = () => "allow") {
  const asked: string[] = [];
  const details: string[] = [];
  const deps: TrustDeps = {
    store: new TrustStore(path.join(dir, "trusted.json")),
    ask: async (message, detail) => {
      asked.push(message);
      details.push(detail);
      return answer();
    },
  };
  return { deps, asked, details };
}
