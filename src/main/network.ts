/**
 * HTTP for auth scripts with the same network settings as Voiden's own
 * requests: "Disable TLS verification", the active proxy and its excluded
 * domains (Settings → Requests / Proxy).
 *
 * Uses undici — the HTTP client Voiden itself uses — bundled into the plugin.
 * Settings are read from Voiden's settings.json on every call, so changes
 * apply without a restart.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

import type { Fetch } from "./http";

export interface NetworkSettings {
  disableTls: boolean;
  proxy?: {
    host: string;
    port: number | string;
    auth?: boolean;
    username?: string;
    password?: string;
    excludedDomains?: string[];
  };
}

interface VoidenSettingsFile {
  requests?: { disable_tls_verification?: boolean };
  proxy?: {
    enabled?: boolean;
    activeProxyId?: string;
    proxies?: (NonNullable<NetworkSettings["proxy"]> & { id?: string })[];
  };
}

export function readNetworkSettings(userDataDir: string): NetworkSettings {
  let file: VoidenSettingsFile = {};
  try {
    file = JSON.parse(readFileSync(path.join(userDataDir, "settings.json"), "utf8"));
  } catch {
    // No settings file yet — Voiden's defaults: verify TLS, no proxy.
  }
  const disableTls = file.requests?.disable_tls_verification === true;
  const proxy =
    file.proxy?.enabled && file.proxy.activeProxyId
      ? file.proxy.proxies?.find((p) => p.id === file.proxy!.activeProxyId)
      : undefined;
  return { disableTls, proxy: proxy?.host ? proxy : undefined };
}

/** Same matching as Voiden: exact host, or "*.example.com" for subdomains and the domain itself. */
export function isExcluded(hostname: string, patterns: string[] = []): boolean {
  return patterns.some((pattern) =>
    pattern.startsWith("*.")
      ? hostname.endsWith(pattern.slice(1)) || hostname === pattern.slice(2)
      : hostname === pattern,
  );
}

export function proxyUrl(proxy: NonNullable<NetworkSettings["proxy"]>): string {
  const credentials =
    proxy.auth && proxy.username
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? "")}@`
      : "";
  return `http://${credentials}${proxy.host}:${proxy.port}`;
}

export function dispatcherFor(url: string, settings: NetworkSettings): Dispatcher {
  const connect = settings.disableTls ? { rejectUnauthorized: false } : undefined;
  const proxy = settings.proxy;
  if (proxy && !isExcluded(new URL(url).hostname, proxy.excludedDomains)) {
    return new ProxyAgent({ uri: proxyUrl(proxy), connect, requestTls: connect, proxyTls: connect });
  }
  return new Agent({ connect });
}

/** A fetch that applies Voiden's current network settings to each request. */
export function voidenFetch(userDataDir: string): Fetch {
  return async (url, init) => {
    const dispatcher = dispatcherFor(url, readNetworkSettings(userDataDir));
    try {
      return (await undiciFetch(url, { ...(init as object), dispatcher })) as unknown as Response;
    } finally {
      void dispatcher.close().catch(() => {});
    }
  };
}
