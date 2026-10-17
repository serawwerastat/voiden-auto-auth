/**
 * Auto Auth — main-process part (Node.js).
 *
 * Voiden loads this bundle in Electron's main process. It runs auth scripts
 * with full Node.js available — after the user has approved them — and
 * returns the headers to add. Matching, caching and UI live in the renderer
 * part, src/plugin.ts.
 */

import path from "node:path";

import { CHANNELS, type RunRequest } from "./shared/protocol";
import { runScript, type RunDeps } from "./main/runScript";
import { TrustStore, type TrustDeps } from "./main/trust";
import type { Fetch } from "./main/http";
import type { IpcEvent, MainProcessContext } from "./voiden";

interface ElectronModule {
  app?: { getPath(name: "userData"): string };
  dialog?: {
    showMessageBox(
      window: unknown,
      options: { type: string; buttons: string[]; defaultId: number; cancelId: number; message: string; detail: string; noLink?: boolean },
    ): Promise<{ response: number }>;
  };
  BrowserWindow?: { getFocusedWindow(): unknown };
}

function loadElectron(): ElectronModule {
  try {
    return require("electron") as ElectronModule;
  } catch {
    return {}; // not running inside Electron (tests)
  }
}

/** Overridable for tests. */
export interface MainDeps {
  fetch: Fetch;
  trust: TrustDeps;
}

function defaultDeps(): MainDeps {
  const electron = loadElectron();
  const storeFile = path.join(electron.app?.getPath("userData") ?? process.cwd(), "auto-auth", "trusted-scripts.json");
  return {
    // Node's fetch, like Voiden's own HTTP requests. (Electron's net.fetch is
    // not used: Chromium adds an Origin header, which CORS-checking servers
    // such as Spring reject with "Invalid CORS request".)
    fetch: (url, init) => fetch(url, init),
    trust: {
      store: new TrustStore(storeFile),
      async ask(message, detail) {
        if (!electron.dialog) return false;
        const { response } = await electron.dialog.showMessageBox(electron.BrowserWindow?.getFocusedWindow() ?? null, {
          type: "warning",
          buttons: ["Allow", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message,
          detail,
          noLink: true,
        });
        return response === 0;
      },
    },
  };
}

export default function createAutoAuthMain(context: MainProcessContext, deps: MainDeps = defaultDeps()) {
  return {
    async onload() {
      context.ipc.handle(CHANNELS.run, async (event: IpcEvent, req: RunRequest) => {
        const projectPath = await context.project.getActive(event);
        if (!projectPath) throw new Error("no project is open");
        const runDeps: RunDeps = {
          resolve: (text) => context.env.replaceVariables(text, event),
          fetch: deps.fetch,
          trust: deps.trust,
        };
        return runScript(req, projectPath, runDeps);
      });
      context.ipc.handle(CHANNELS.forgetTrust, () => deps.trust.store.clear());
    },
    async onunload() {
      context.ipc.removeHandler(CHANNELS.run);
      context.ipc.removeHandler(CHANNELS.forgetTrust);
    },
  };
}
