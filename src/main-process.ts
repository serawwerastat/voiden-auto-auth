/**
 * Auto Auth — main-process part (Node.js).
 *
 * Voiden loads this bundle in Electron's main process. It runs auth scripts
 * with full Node.js available — after the user has approved them, each in
 * its own worker thread — and returns the headers to add. Matching, caching
 * and UI live in the renderer part, src/plugin.ts.
 */

import path from "node:path";

import { CHANNELS, type RunRequest, type RunResponse } from "./shared/protocol";
import { runScript } from "./main/runScript";
import { ReviewRequested, TrustStore, type Answer, type TrustDeps } from "./main/trust";
import type { IpcEvent, MainProcessContext } from "./voiden";

export interface ElectronModule {
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
  /** Voiden's user data folder: its network settings, and this plugin's approvals. */
  userDataDir: string;
  trust: TrustDeps;
}

/** The dialog's buttons, in order, and the answer each one gives. */
const BUTTONS: [label: string, answer: Answer][] = [
  ["Allow", "allow"],
  ["Open script", "open"], // shows it in Voiden's editor; see src/engine.ts
  ["Cancel", "deny"],
];

/** Asks with a native dialog. Anything but a click on "Allow" or "Open script" declines. */
export function askWithDialog(electron: ElectronModule): TrustDeps["ask"] {
  return async (message, detail) => {
    if (!electron.dialog) return "deny";
    const cancel = BUTTONS.length - 1;
    const { response } = await electron.dialog.showMessageBox(electron.BrowserWindow?.getFocusedWindow() ?? null, {
      type: "warning",
      buttons: BUTTONS.map(([label]) => label),
      defaultId: cancel,
      cancelId: cancel,
      message,
      detail,
      noLink: true,
    });
    return BUTTONS[response]?.[1] ?? "deny";
  };
}

function defaultDeps(): MainDeps {
  const electron = loadElectron();
  const userData = electron.app?.getPath("userData") ?? process.cwd();
  return {
    userDataDir: userData,
    trust: {
      store: new TrustStore(path.join(userData, "auto-auth", "trusted-scripts.json")),
      ask: askWithDialog(electron),
    },
  };
}

export default function createAutoAuthMain(context: MainProcessContext, deps: MainDeps = defaultDeps()) {
  return {
    async onload() {
      context.ipc.handle(CHANNELS.run, async (event: IpcEvent, req: RunRequest): Promise<RunResponse> => {
        const projectPath = await context.project.getActive(event);
        if (!projectPath) throw new Error("no project is open");
        try {
          return await runScript(req, projectPath, {
            resolve: (text) => context.env.replaceVariables(text, event),
            trust: deps.trust,
            userDataDir: deps.userDataDir,
          });
        } catch (e) {
          // Not a failure: the user asked to read the script first. The
          // renderer opens it in the editor.
          if (e instanceof ReviewRequested) return { review: e.script };
          throw e;
        }
      });
      context.ipc.handle(CHANNELS.forgetTrust, () => deps.trust.store.clear());
    },
    async onunload() {
      context.ipc.removeHandler(CHANNELS.run);
      context.ipc.removeHandler(CHANNELS.forgetTrust);
    },
  };
}
