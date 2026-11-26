/**
 * The `auth` object auth scripts receive.
 */

import { jwtExpiry } from "../shared/result";
import type { RunRequest } from "../shared/protocol";
import { send, type Fetch, type Resolve, type SendOptions } from "./http";

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

export interface ApiDeps {
  resolve: Resolve;
  fetch: Fetch;
  /** Receives each auth.log() line. */
  log(line: string): void;
}

const formatLogArg = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function makeAuthApi(run: Pick<RunRequest, "service" | "request">, deps: ApiDeps): AuthApi {
  return {
    service: run.service,
    request: run.request,
    send: (options) => send(options, deps.resolve, deps.fetch),
    env: async (name) => {
      const placeholder = `{{${name}}}`;
      const value = await deps.resolve(placeholder);
      return value === placeholder ? undefined : value;
    },
    resolve: deps.resolve,
    base64: (text) => Buffer.from(String(text), "utf8").toString("base64"),
    jwtExpiry,
    log: (...args) => deps.log(args.map(formatLogArg).join(" ")),
  };
}
