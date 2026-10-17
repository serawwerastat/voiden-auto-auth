/**
 * What the status bar shows: the service that applies to the request open in
 * the editor, every service's token state, and recent events (running,
 * failed, rejected). A tiny observable store the widget subscribes to.
 */

import { isFresh, readCache, type CacheScope } from "./cache";
import type { ServiceRule } from "./config";

export type EventKind = "pending" | "failed" | "rejected" | "uncached";

export type Focus =
  | { kind: "idle" } // nothing checked yet
  | { kind: "no-file" } // no .void file open
  | { kind: "no-request" } // open file has no HTTP URL
  | { kind: "no-rule" } // request matches no rule
  | { kind: "service"; name: string };

export interface ServiceState {
  name: string;
  /** Expiry of the cached token, 0 when none. */
  expiresAt: number;
  /** When the cached token was obtained, 0 when none. */
  obtainedAt: number;
}

export interface Snapshot {
  configError: string;
  /** False when the project has no auth config file. */
  configured: boolean;
  services: ServiceState[];
  focus: Focus;
  events: Record<string, { kind: EventKind; message: string }>;
}

type Listener = () => void;

class StatusStore {
  private snapshot: Snapshot = { configError: "", configured: false, services: [], focus: { kind: "idle" }, events: {} };
  private readonly listeners = new Set<Listener>();

  get(): Snapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies a change; listeners are only told when something actually differs. */
  private update(patch: Partial<Snapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    this.listeners.forEach((fn) => fn());
  }

  setEvent(service: string, kind: EventKind, message = "") {
    this.update({ events: { ...this.snapshot.events, [service]: { kind, message } } });
  }

  clearEvent(service: string) {
    if (!(service in this.snapshot.events)) return;
    const events = { ...this.snapshot.events };
    delete events[service];
    this.update({ events });
  }

  clearAllEvents() {
    this.update({ events: {} });
  }

  /** Services from the config with their cached token state; `rules === null` = no config file. */
  setRules(rules: ServiceRule[] | null, scope: CacheScope | null, configError = "") {
    const services: ServiceState[] = (rules ?? [])
      .filter((rule) => rule.enabled)
      .map((rule) => {
        const cached = scope ? readCache(scope, rule.name) : null;
        return { name: rule.name, expiresAt: cached?.expiresAt ?? 0, obtainedAt: cached?.obtainedAt ?? 0 };
      });
    this.update({ services, configError, configured: rules !== null || configError !== "" });
  }

  setFocus(focus: Focus) {
    this.update({ focus });
  }
}

export const status = new StatusStore();

// ── Presentation ────────────────────────────────────────────────────────────

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

export interface ServiceLabel {
  text: string;
  tone: "normal" | "dim" | "warning" | "error";
  detail?: string;
}

/** How one service's state reads, e.g. "42m", "logging in…", "failed". */
export function describeService(snapshot: Snapshot, name: string, now = Date.now()): ServiceLabel {
  const event = snapshot.events[name];
  const service = snapshot.services.find((s) => s.name === name);
  const expiresAt = service?.expiresAt ?? 0;
  if (event?.kind === "pending") return { text: "logging in…", tone: "normal" };
  if (isFresh({ headers: {}, expiresAt, obtainedAt: service?.obtainedAt ?? 0 }, now)) {
    return { text: formatRemaining(expiresAt - now), tone: "normal" };
  }
  if (event?.kind === "failed") return { text: "failed", tone: "error", detail: event.message };
  if (event?.kind === "rejected") return { text: "rejected", tone: "warning", detail: event.message };
  if (event?.kind === "uncached") return { text: "per request", tone: "normal" };
  if (expiresAt) return { text: "expired", tone: "dim" };
  return { text: "not logged in", tone: "dim" };
}

/** The short text in the status bar. */
export function statusBarLabel(snapshot: Snapshot, now = Date.now()): ServiceLabel {
  if (snapshot.configError) return { text: "config error", tone: "error", detail: snapshot.configError };
  if (snapshot.focus.kind !== "service") return { text: "—", tone: "dim" };
  const label = describeService(snapshot, snapshot.focus.name, now);
  return { ...label, text: `${snapshot.focus.name} · ${label.text}` };
}

/** The hover text: what applies to the open request and every service's state. */
export function statusTooltip(snapshot: Snapshot, now = Date.now()): string {
  if (snapshot.configError) return `Auto Auth — ${snapshot.configError}`;
  if (!snapshot.configured) {
    return "Auto Auth — no auth config in this project.\nRun “Auto Auth: Create example config” from the command palette.";
  }

  const focus = snapshot.focus;
  const lines: string[] = [];
  switch (focus.kind) {
    case "service":
      lines.push(`Open request → ${focus.name}`);
      break;
    case "no-rule":
      lines.push("Open request → no rule (no headers added)");
      break;
    case "no-request":
      lines.push("Open file has no HTTP request");
      break;
    default:
      lines.push("No request open");
  }

  lines.push("");
  if (snapshot.services.length === 0) {
    lines.push("No services in the auth config");
  } else {
    const width = Math.max(...snapshot.services.map((s) => s.name.length));
    for (const s of snapshot.services) {
      const d = describeService(snapshot, s.name, now);
      const state = d.tone === "normal" && /^\d|^</.test(d.text) ? `valid · ${d.text}` : d.text;
      const marker = focus.kind === "service" && focus.name === s.name ? "▸ " : "  ";
      lines.push(`${marker}${s.name.padEnd(width + 2)}${state}${d.detail ? ` (${d.detail})` : ""}`);
    }
  }

  lines.push("", focus.kind === "service" ? `Click: clear the ${focus.name} token` : "Click: clear all tokens");
  return lines.join("\n");
}
