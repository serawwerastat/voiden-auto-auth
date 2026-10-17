import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import createPlugin from "../src/plugin";
import { CHANNELS, fullChannel, type AuthResult, type RunRequest } from "../src/shared/protocol";
import { status, statusBarLabel, statusTooltip } from "../src/status";
import type { PluginContext, RequestState } from "../src/voiden";

// ── A simulated Voiden host ──────────────────────────────────────────────────

const PROJECT = "C:\\work\\api-project";
const env: Record<string, string> = { api_url: "https://api.example.com" };
const files = new Map<string, string>();
const storage = new Map<string, string>();
const settings = new Map<string, unknown>();
const toasts: string[] = [];
const runs: RunRequest[] = [];
const forgotTrust: number[] = [];
let mainResponse: (req: RunRequest) => Promise<AuthResult>;
let activeFile: string | undefined;
let activeEnv = "dev";
let ipcAvailable = true;

const ok = (token = "tok"): AuthResult => ({
  headers: { Authorization: `Bearer ${token}` },
  expiresAt: Date.now() + 42 * 60_000,
  cache: true,
});
const relative = (p: string) => p.replace(/\\/g, "/").replace(PROJECT.replace(/\\/g, "/") + "/", "");

(globalThis as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => void storage.set(k, v),
  removeItem: (k) => void storage.delete(k),
};

(globalThis as unknown as { window: Window }).window = {
  electron: {
    env: { replaceVariables: async (t: string) => t.replace(/\{\{(\w+)\}\}/g, (m, k) => env[k] ?? m) },
    variables: { getActiveEnvKey: async () => activeEnv },
    files: { read: async (p: string) => files.get(relative(p)) ?? "" },
    tab: { getActiveTab: async () => ({ source: activeFile }) },
    ipc: {
      invoke: async (channel: string, payload: unknown) => {
        if (!ipcAvailable || !channel.startsWith("ext:auto-auth:")) throw new Error(`No handler registered for '${channel}'`);
        if (channel === fullChannel(CHANNELS.forgetTrust)) return void forgotTrust.push(1);
        runs.push(payload as RunRequest);
        await new Promise((r) => setTimeout(r, 5));
        return mainResponse(payload as RunRequest);
      },
    },
  },
  __voiden_shims__: {},
} as unknown as Window;

const hooks: Record<string, (ctx: unknown) => Promise<void>> = {};
const commands: Record<string, () => Promise<void> | void> = {};
const listeners: Record<string, () => void> = {};
let statusBarClick: () => void = () => {};

const context = {
  pipeline: {
    registerHook: async (stage: string, fn: (ctx: unknown) => Promise<void>) => void (hooks[stage] = fn),
    unregister: async () => {},
  },
  settings: { get: async (k: string) => settings.get(k) },
  fs: {
    read: async (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    write: async (p: string, c: string) => void files.set(p, c),
    exists: async (p: string) => files.has(p),
    createDirectory: async () => {},
  },
  project: { getPath: async () => PROJECT, openFile: async () => {} },
  events: { on: (event: string, fn: () => void) => ((listeners[event] = fn), () => delete listeners[event]) },
  registerCommand: (c: { id: string; action: () => Promise<void> }) => void (commands[c.id] = c.action),
  registerStatusBarItem: (item: { onClick: () => void }) => void (statusBarClick = item.onClick),
  ui: { showToast: (m: string, t: string) => void toasts.push(`${t}: ${m}`), registerSettings: () => {} },
} as unknown as PluginContext;

const plugin = createPlugin(context);
await plugin.onload();
after(() => plugin.onunload());

const CONFIG = JSON.stringify({
  services: [
    { name: "admin", folder: "admin", match: "{{api_url}}", script: ".voiden-auth/admin.js" },
    { name: "my-api", match: "{{api_url}}", script: ".voiden-auth/my-api.js" },
  ],
});
const withConfig = () => files.set(".voiden-auth/auth.yaml", CONFIG);

type SentRequest = Required<Pick<RequestState, "headers">> & { metadata: Record<string, unknown> };
const send = async (url: string, headers: { key: string; value: string }[] = [], file = "users\\List.void") => {
  activeFile = `${PROJECT}\\${file}`;
  const requestState = { url, method: "GET", headers: [...headers], metadata: {} as Record<string, unknown> };
  await hooks["pre-send"]({ requestState });
  return requestState as SentRequest;
};
const authHeader = (rs: SentRequest) => rs.headers.filter((h) => h.key === "Authorization").map((h) => h.value);
const refresh = async () => {
  listeners["tab:changed"]?.();
  await new Promise((r) => setTimeout(r, 20));
};

beforeEach(() => {
  files.clear();
  storage.clear();
  settings.clear();
  toasts.length = 0;
  runs.length = 0;
  forgotTrust.length = 0;
  activeFile = undefined;
  activeEnv = "dev";
  ipcAvailable = true;
  status.clearAllEvents();
  mainResponse = async () => ok();
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("without a config file nothing is added", async () => {
  const rs = await send("{{api_url}}/users");
  assert.deepEqual(rs.headers, []);
  assert.equal(rs.metadata.preScriptError, undefined);
  assert.equal(runs.length, 0);
});

test("the example command creates a config and script outside .voiden/", async () => {
  await commands["auto-auth.create-example"]();
  assert.match(files.get(".voiden-auth/auth.yaml") ?? "", /name: my-api/);
  assert.match(files.get(".voiden-auth/my-api.js") ?? "", /auth\.send/);
});

test("a matching request runs the script once, then uses the cache", async () => {
  withConfig();
  const first = await send("{{api_url}}/users");
  assert.deepEqual(authHeader(first), ["Bearer tok"]);
  assert.equal(first.metadata.autoAuthService, "my-api");
  assert.equal(typeof first.metadata.autoAuthTag, "string");
  assert.ok(toasts.includes("success: Auto Auth: my-api authorized"));
  assert.deepEqual(runs[0], {
    service: "my-api",
    header: "Authorization",
    scriptPath: "C:/work/api-project/.voiden-auth/my-api.js",
    request: { url: "https://api.example.com/users", method: "GET", file: "users/List.void" },
  });

  const second = await send("https://api.example.com/other");
  assert.deepEqual(authHeader(second), ["Bearer tok"]);
  assert.equal(runs.length, 1, "served from cache");
  assert.ok(![...storage.values()].some((v) => v.includes("api.example.com")), "only headers are stored");
});

test("folder rules take precedence when listed first", async () => {
  withConfig();
  mainResponse = async (req) => ok(req.service);
  assert.deepEqual(authHeader(await send("{{api_url}}/users/1", [], "admin\\Delete.void")), ["Bearer admin"]);
});

test("parallel requests share one script run", async () => {
  withConfig();
  await Promise.all([send("{{api_url}}/a"), send("{{api_url}}/b"), send("{{api_url}}/c")]);
  assert.equal(runs.length, 1);
});

test("each environment logs in separately", async () => {
  withConfig();
  mainResponse = async () => ok(activeEnv);
  assert.deepEqual(authHeader(await send("{{api_url}}/x")), ["Bearer dev"]);
  activeEnv = "prod";
  assert.deepEqual(authHeader(await send("{{api_url}}/x")), ["Bearer prod"]);
  activeEnv = "dev";
  assert.deepEqual(authHeader(await send("{{api_url}}/x")), ["Bearer dev"]);
  assert.equal(runs.length, 2);
});

test("unmatched requests and requests with their own header are left alone", async () => {
  withConfig();
  assert.deepEqual((await send("https://elsewhere.example.org/x")).headers, []);
  const own = await send("{{api_url}}/x", [{ key: "authorization", value: "Bearer mine" }]);
  assert.deepEqual(own.headers, [{ key: "authorization", value: "Bearer mine" }]);
});

test("a 401 or 403 drops the token so the next request authorizes again", async () => {
  withConfig();
  const rs = await send("{{api_url}}/x");
  await hooks["post-processing"]({ requestState: rs, responseState: { status: 403 } });
  assert.equal(statusBarLabel({ ...status.get(), focus: { kind: "service", name: "my-api" } }).text, "my-api · rejected");
  await send("{{api_url}}/x");
  assert.equal(runs.length, 2);
});

test("a late 401 does not discard a token refreshed in the meantime", async () => {
  withConfig();
  const old = await send("{{api_url}}/x");
  storage.clear(); // token expired…
  mainResponse = async () => ok("new");
  await send("{{api_url}}/y"); // …and was refreshed
  await hooks["post-processing"]({ requestState: old, responseState: { status: 401 } });
  assert.deepEqual(authHeader(await send("{{api_url}}/z")), ["Bearer new"]);
  assert.equal(runs.length, 2, "no extra login");
});

test("script failures stop the request with the reason", async () => {
  withConfig();
  mainResponse = async () => {
    throw new Error("Error invoking remote method 'ext:auto-auth:run': Error: POST {{api_url}}/login → HTTP 401: bad credentials");
  };
  const rs = await send("{{api_url}}/x");
  assert.equal(rs.metadata.preScriptError, "Auto Auth (my-api): POST {{api_url}}/login → HTTP 401: bad credentials");
  assert.deepEqual(rs.headers, []);
  assert.ok(toasts.some((t) => t.startsWith("error: Auto Auth (my-api)")));
});

test("a declined script stops the request", async () => {
  withConfig();
  mainResponse = async () => {
    throw new Error("Error invoking remote method 'ext:auto-auth:run': Error: running .voiden-auth/my-api.js was not allowed");
  };
  assert.equal((await send("{{api_url}}/x")).metadata.preScriptError, "Auto Auth (my-api): running .voiden-auth/my-api.js was not allowed");
});

test("a missing main-process part asks for a restart", async () => {
  withConfig();
  ipcAvailable = false;
  assert.match(String((await send("{{api_url}}/x")).metadata.preScriptError), /restart Voiden/);
});

test("a broken config stops matching requests with the parse error", async () => {
  files.set(".voiden-auth/auth.yaml", "{ not json");
  assert.match(String((await send("{{api_url}}/x")).metadata.preScriptError), /^Auto Auth: \.voiden-auth\/auth\.yaml: /);
});

test("the Enabled setting switches everything off", async () => {
  withConfig();
  settings.set("enabled", false);
  assert.deepEqual((await send("{{api_url}}/x")).headers, []);
});

test("Forget allowed scripts goes to the main process", async () => {
  await commands["auto-auth.forget-trusted"]();
  assert.equal(forgotTrust.length, 1);
});

test("the status bar follows the open request; clicking clears only its token", async () => {
  withConfig();
  files.set("users/List.void", "```void\n---\ntype: request\ncontent:\n  - type: url\n    content: {{api_url}}/users\n---\n```");
  files.set("notes/Readme.void", "# Notes");
  await send("{{api_url}}/users", [], "admin\\Delete.void");
  await send("{{api_url}}/users");

  activeFile = `${PROJECT}\\users\\List.void`;
  await refresh();
  assert.equal(statusBarLabel(status.get()).text, "my-api · 42m");
  const tip = statusTooltip(status.get());
  assert.match(tip, /Open request → my-api/);
  assert.match(tip, /▸ my-api\s+valid · 42m/);
  assert.match(tip, /admin\s+valid · 42m/);

  statusBarClick();
  await refresh();
  assert.equal(statusBarLabel(status.get()).text, "my-api · not logged in");
  assert.match(statusTooltip(status.get()), /admin\s+valid · 42m/, "other services keep their token");

  activeFile = `${PROJECT}\\notes\\Readme.void`;
  await refresh();
  assert.equal(statusBarLabel(status.get()).text, "—");
});
