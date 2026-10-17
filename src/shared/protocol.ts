/**
 * What the renderer and the main process exchange over IPC.
 */

import manifest from "../../manifest.json";

/** IPC channels; Voiden namespaces them to `ext:<plugin id>:<channel>`. */
export const CHANNELS = { run: "run", forgetTrust: "forget-trust" } as const;
export const fullChannel = (channel: string) => `ext:${manifest.id}:${channel}`;

export interface RunRequest {
  /** Service name from the auth config. */
  service: string;
  /** Header used for `bearer` / `token` results. */
  header: string;
  /** Absolute path of the auth script. */
  scriptPath: string;
  /** The request being authorized, as information for the script. */
  request: { url: string; method?: string; file?: string };
}

/** Headers to add, when they expire, and whether to cache them. */
export interface AuthResult {
  headers: Record<string, string>;
  /** Epoch milliseconds. */
  expiresAt: number;
  cache: boolean;
  /** Lines the script wrote with auth.log(), shown in the developer console. */
  logs?: string[];
}
