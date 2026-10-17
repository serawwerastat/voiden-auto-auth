/** Shared test helpers for the main-process side. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TrustStore, type TrustDeps } from "../src/main/trust";

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Trust deps that record questions and answer with `answer()`. */
export function fakeTrust(dir: string, answer: () => boolean = () => true) {
  const asked: string[] = [];
  const deps: TrustDeps = {
    store: new TrustStore(path.join(dir, "trusted.json")),
    ask: async (message) => {
      asked.push(message);
      return answer();
    },
  };
  return { deps, asked };
}
