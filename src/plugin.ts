/**
 * Auto Auth — renderer part.
 *
 * Before each request is sent, finds the rule in the project's auth config
 * that applies to it, gets that service's headers (cached, or by running the
 * service's auth script in the main process — see src/main-process.ts) and
 * adds them to the request. After a 401/403 the token is dropped so the next
 * request authorizes again. A status bar item shows what applies to the
 * request open in the editor.
 */

import manifest from "../manifest.json";
import { headersTag } from "./cache";
import type { ServiceRule } from "./config";
import { AuthEngine } from "./engine";
import { DEFAULT_CONFIG_PATH, getActiveFile, hostModule, invokeMain, readAbsolute, toast } from "./host";
import { CHANNELS, fullChannel } from "./shared/protocol";
import { status } from "./status";
import { StatusWidget } from "./StatusWidget";
import { EXAMPLE_CONFIG, EXAMPLE_SCRIPT, EXAMPLE_SCRIPT_PATH } from "./templates";
import { parseRequestUrl } from "./voidFile";
import type { Plugin, PluginContext, PostProcessingContext, PreSendContext, RequestState } from "./voiden";

/** Pre-send hooks run in ascending priority (default 100); this runs late. */
const HOOK_PRIORITY = 200;
/** Background refresh for the status bar: expiry countdown, files opened from the file tree. */
const STATUS_POLL_MS = 5000;
const SERVICE_KEY = "autoAuthService";
const TAG_KEY = "autoAuthTag";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Stop the request with a reason. Voiden ignores errors thrown by pipeline
 * hooks; a pre-send error is reported through this metadata field instead.
 */
function stopRequest(requestState: RequestState, message: string): void {
  requestState.metadata = { ...requestState.metadata, preScriptError: message };
}

export default function createAutoAuthPlugin(context: PluginContext): Plugin {
  const engine = new AuthEngine(context);
  const unsubscribe: (() => void)[] = [];
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  async function isEnabled(): Promise<boolean> {
    const enabled = await context.settings.get<boolean | string>("enabled").catch(() => undefined);
    return enabled !== false && enabled !== "false";
  }

  // ── Pipeline hooks ────────────────────────────────────────────────────────

  async function beforeSend({ requestState }: PreSendContext): Promise<void> {
    if (!requestState?.url || !(await isEnabled())) return;

    let rules: ServiceRule[] | null;
    try {
      rules = await engine.loadRules();
    } catch (e) {
      const message = `Auto Auth: ${errorMessage(e)}`;
      toast(context, message, "error");
      stopRequest(requestState, message);
      return;
    }
    if (!rules?.length) return;

    // Voiden adds the request's file path to the metadata only after the
    // pre-send stage; until then the open tab is the best guide.
    const filePath = requestState.metadata?.requestFilePath ?? (await getActiveFile(context));
    const matched = await engine.match(rules, { url: requestState.url, filePath });
    if (!matched) return;

    try {
      const auth = await engine.authorize(matched.rule, { url: matched.url, method: requestState.method, filePath });
      const headers = (requestState.headers ??= []);
      for (const [name, value] of Object.entries(auth.headers)) {
        const alreadySet = headers.some(
          (h) => h.enabled !== false && h.key?.toLowerCase() === name.toLowerCase() && String(h.value ?? "").trim(),
        );
        if (!alreadySet) headers.push({ key: name, value, enabled: true });
      }
      requestState.metadata = {
        ...requestState.metadata,
        [SERVICE_KEY]: matched.rule.name,
        [TAG_KEY]: headersTag(auth.headers),
      };
    } catch (e) {
      const message = `Auto Auth (${matched.rule.name}): ${errorMessage(e)}`;
      toast(context, message, "error");
      stopRequest(requestState, message);
    } finally {
      void refreshStatus();
    }
  }

  async function afterResponse({ requestState, responseState }: PostProcessingContext): Promise<void> {
    const service = requestState?.metadata?.[SERVICE_KEY];
    const sentTag = requestState?.metadata?.[TAG_KEY];
    const code = responseState?.status;
    // Many servers answer 403 rather than 401 for an expired token.
    if (typeof service === "string" && (code === 401 || code === 403)) {
      await engine.forget(service, { status: code, sentTag: typeof sentTag === "string" ? sentTag : undefined });
      void refreshStatus();
    }
  }

  // ── Status bar ────────────────────────────────────────────────────────────

  let refreshing: Promise<void> | null = null;
  function refreshStatus(): Promise<void> {
    refreshing ??= updateStatus().finally(() => (refreshing = null));
    return refreshing;
  }

  async function updateStatus(): Promise<void> {
    let rules: ServiceRule[] = [];
    try {
      const loaded = await engine.loadRules();
      status.setRules(loaded, await engine.scope());
      rules = loaded ?? [];
    } catch (e) {
      status.setRules(null, null, errorMessage(e));
    }

    const filePath = await getActiveFile(context);
    if (!filePath || !/\.void$/i.test(filePath)) return status.setFocus({ kind: "no-file" });
    if (rules.length === 0) return status.setFocus({ kind: "no-rule" });

    const url = parseRequestUrl(await readAbsolute(filePath));
    if (!url) return status.setFocus({ kind: "no-request" });

    const matched = await engine.match(rules, { url, filePath });
    status.setFocus(matched ? { kind: "service", name: matched.rule.name } : { kind: "no-rule" });
  }

  /** Clears the token of the service shown in the status bar, or every token when none is shown. */
  async function clearTokens(onlyShown: boolean): Promise<void> {
    const focus = status.get().focus;
    if (onlyShown && focus.kind === "service") {
      await engine.forget(focus.name);
      toast(context, `Auto Auth: ${focus.name} token cleared`, "success");
    } else {
      const rules = (await engine.loadRules().catch(() => null)) ?? [];
      await Promise.all(rules.map((r) => engine.forget(r.name)));
      status.clearAllEvents();
      toast(context, "Auto Auth: all cached tokens cleared", "success");
    }
    await refreshStatus();
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  async function createExampleConfig(): Promise<void> {
    const configPath = await engine.configPath();
    const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    try {
      if (await context.fs.exists(configPath)) {
        toast(context, `Auto Auth: ${configPath} already exists`, "info");
      } else {
        if (dirOf(configPath)) await context.fs.createDirectory(dirOf(configPath));
        await context.fs.write(configPath, EXAMPLE_CONFIG);
        if (!(await context.fs.exists(EXAMPLE_SCRIPT_PATH))) {
          await context.fs.createDirectory(dirOf(EXAMPLE_SCRIPT_PATH));
          await context.fs.write(EXAMPLE_SCRIPT_PATH, EXAMPLE_SCRIPT);
        }
        toast(context, `Auto Auth: created ${configPath} and ${EXAMPLE_SCRIPT_PATH}`, "success");
      }
      await context.project.openFile(configPath);
    } catch (e) {
      toast(context, `Auto Auth: could not create the example — ${errorMessage(e)}`, "error");
    }
    await refreshStatus();
  }

  async function forgetAllowedScripts(): Promise<void> {
    try {
      await invokeMain(fullChannel(CHANNELS.forgetTrust));
      toast(context, "Auto Auth: you'll be asked again before each script runs", "success");
    } catch (e) {
      toast(context, `Auto Auth: ${errorMessage(e)}`, "error");
    }
  }

  const icons = () => hostModule<Record<string, unknown>>("lucide-react") ?? {};

  return {
    async onload() {
      await context.pipeline.registerHook("pre-send", beforeSend as (ctx: never) => unknown, HOOK_PRIORITY);
      await context.pipeline.registerHook("post-processing", afterResponse as (ctx: never) => unknown, HOOK_PRIORITY);

      context.registerCommand({
        id: "auto-auth.create-example",
        label: "Auto Auth: Create example config",
        description: `Creates ${DEFAULT_CONFIG_PATH} and an example auth script`,
        icon: icons().FilePlus,
        action: createExampleConfig,
      });
      context.registerCommand({
        id: "auto-auth.clear-tokens",
        label: "Auto Auth: Clear cached tokens",
        description: "The next request to each service authorizes again",
        icon: icons().RotateCcw,
        action: () => clearTokens(false),
      });
      context.registerCommand({
        id: "auto-auth.forget-trusted",
        label: "Auto Auth: Forget allowed scripts",
        description: "Ask again before each auth script runs",
        icon: icons().ShieldOff,
        action: forgetAllowedScripts,
      });

      context.registerStatusBarItem({
        id: "auto-auth.status",
        icon: StatusWidget, // Voiden renders the icon as <Icon size={…} />, so the live label fits here
        tooltip: "Auto Auth",
        position: "right",
        onClick: () => void clearTokens(true),
      });

      context.ui.registerSettings?.({
        id: "auto-auth",
        title: "Auto Auth",
        icon: icons().KeyRound,
        fields: [
          {
            type: "toggle",
            key: "enabled",
            label: "Enabled",
            description: "Authorize requests using the scripts in the auth config",
            defaultValue: true,
          },
          {
            type: "text",
            key: "configPath",
            label: "Config file",
            description: "Relative to the project root",
            defaultValue: DEFAULT_CONFIG_PATH,
            placeholder: DEFAULT_CONFIG_PATH,
          },
        ],
      });

      for (const event of ["tab:changed", "file:saved", "environment:changed", "project:changed"]) {
        const off = context.events?.on(event, () => void refreshStatus());
        if (off) unsubscribe.push(off);
      }
      void refreshStatus();
      pollTimer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    },

    async onunload() {
      clearInterval(pollTimer);
      unsubscribe.forEach((off) => off());
      await context.pipeline.unregister();
    },

    metadata: manifest,
  };
}
