/**
 * Deciding which service authorizes a request, and getting its headers —
 * from the cache when fresh, otherwise by running the service's script in the
 * main process. Parallel requests for the same service and environment share
 * one run.
 */

import { clearCache, headersTag, isFresh, readCache, writeCache, type CacheScope, type CachedAuth } from "./cache";
import { parseConfig, pickService, type ServiceRule } from "./config";
import {
  DEFAULT_CONFIG_PATH,
  getActiveEnvKey,
  getProjectPath,
  getSetting,
  hostModule,
  invokeMain,
  resolveVariables,
  toast,
} from "./host";
import { joinPath, relativeTo } from "./shared/paths";
import { CHANNELS, fullChannel, type AuthResult, type RunRequest } from "./shared/protocol";
import { status } from "./status";
import type { PluginContext } from "./voiden";

export interface RequestInfo {
  url: string;
  method?: string;
  /** Absolute path of the request's .void file, when known. */
  filePath?: string;
}

export class AuthEngine {
  private readonly inflight = new Map<string, Promise<CachedAuth>>();
  private lastConfig: { path: string; text: string; rules: ServiceRule[] } | null = null;

  constructor(private readonly context: PluginContext) {}

  configPath(): Promise<string> {
    return getSetting(this.context, "configPath", DEFAULT_CONFIG_PATH);
  }

  async scope(): Promise<CacheScope> {
    const [project, env] = await Promise.all([getProjectPath(this.context), getActiveEnvKey()]);
    return { project, env };
  }

  /** Rules from the config file; `null` when there is no config file. */
  async loadRules(): Promise<ServiceRule[] | null> {
    const path = await this.configPath();
    let text: string;
    try {
      text = (await this.context.fs.read(path)) ?? "";
    } catch {
      return null;
    }
    if (this.lastConfig?.path === path && this.lastConfig.text === text) return this.lastConfig.rules;

    const yaml = hostModule<{ parse(text: string): unknown }>("yaml");
    const parse = yaml?.parse ?? ((t: string) => JSON.parse(t)); // JSON is valid YAML
    try {
      const rules = parseConfig(text, parse);
      this.lastConfig = { path, text, rules };
      return rules;
    } catch (e) {
      throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The rule that applies to a request, or null. `url` may contain {{variables}}. */
  async match(rules: ServiceRule[], request: RequestInfo): Promise<{ rule: ServiceRule; url: string } | null> {
    const projectPath = await getProjectPath(this.context);
    const resolve = (text: string) => resolveVariables(text, request.filePath);
    const url = await resolve(request.url);
    const file = request.filePath ? relativeTo(projectPath, request.filePath) : "";
    const rule = await pickService(rules, { url, file }, resolve);
    return rule ? { rule, url } : null;
  }

  /** Headers for `rule`: cached if still fresh, otherwise from running its script. */
  async authorize(rule: ServiceRule, request: RequestInfo & { url: string }): Promise<CachedAuth> {
    const scope = await this.scope();
    const cached = readCache(scope, rule.name);
    if (isFresh(cached)) return cached;

    // Keyed by environment too: a login started in one environment must not
    // be reused (or cached) for another.
    const key = `${scope.project}|${scope.env}|${rule.name}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.run(rule, request, scope).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async run(rule: ServiceRule, request: RequestInfo & { url: string }, scope: CacheScope): Promise<CachedAuth> {
    const payload: RunRequest = {
      service: rule.name,
      header: rule.header,
      scriptPath: joinPath(scope.project, rule.script),
      request: {
        url: request.url,
        method: request.method,
        file: request.filePath ? relativeTo(scope.project, request.filePath) : undefined,
      },
    };

    status.setEvent(rule.name, "pending");
    try {
      const result = await invokeMain<AuthResult>(fullChannel(CHANNELS.run), payload);
      for (const line of result.logs ?? []) console.log(`[Auto Auth:${rule.name}]`, line);

      if (!result.cache) {
        status.setEvent(rule.name, "uncached");
        return { headers: result.headers, expiresAt: result.expiresAt, obtainedAt: Date.now() };
      }
      const entry = writeCache(scope, rule.name, result);
      status.clearEvent(rule.name);
      toast(this.context, `Auto Auth: ${rule.name} authorized`, "success");
      return entry;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      status.setEvent(rule.name, "failed", message);
      throw new Error(message);
    }
  }

  /**
   * Forget a service's token so the next request runs its script again.
   * With `sentTag`, only when the cached token is still the one that was
   * sent — a late 401 must not discard a token refreshed in the meantime.
   */
  async forget(service: string, reason?: { status: number; sentTag?: string }): Promise<void> {
    const scope = await this.scope();
    if (reason?.sentTag) {
      const cached = readCache(scope, service);
      if (cached && headersTag(cached.headers) !== reason.sentTag) return;
    }
    clearCache(scope, service);
    if (reason) status.setEvent(service, "rejected", `HTTP ${reason.status}`);
    else status.clearEvent(service);
  }
}
