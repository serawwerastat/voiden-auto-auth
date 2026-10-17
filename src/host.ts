/**
 * Small wrappers around Voiden's renderer APIs, so the rest of the plugin
 * doesn't deal with optional methods and path formats.
 *
 * Besides the plugin context, this uses Voiden's preload bridge
 * (`window.electron`) for things the context doesn't offer: reading files by
 * absolute path, filling in {{variables}}, the active environment's key, and
 * calling this plugin's own main-process part.
 */

import type { PluginContext } from "./voiden";

export const DEFAULT_CONFIG_PATH = ".voiden-auth/auth.yaml";

const bridge = () => window.electron ?? {};

export async function getProjectPath(context: PluginContext): Promise<string> {
  try {
    return (await context.project.getPath?.()) ?? (await context.project.getActiveProject?.()) ?? "";
  } catch {
    return "";
  }
}

/** Key of the active environment; runtime state is kept per environment. */
export async function getActiveEnvKey(): Promise<string> {
  try {
    return String((await bridge().variables?.getActiveEnvKey?.()) ?? "default");
  } catch {
    return "default";
  }
}

/** Absolute path of the file open in the editor, if any. */
export async function getActiveFile(context: PluginContext): Promise<string | undefined> {
  try {
    const getter = context.tab?.getActiveTab ?? bridge().tab?.getActiveTab;
    return (await getter?.())?.source || undefined;
  } catch {
    return undefined;
  }
}

/** Reads a file by absolute path; "" when it can't be read. */
export async function readAbsolute(path: string): Promise<string> {
  try {
    return (await bridge().files?.read(path)) ?? "";
  } catch {
    return "";
  }
}

/** Fills in {{variables}} from the active environment (and folder .env files of `filePath`). */
export async function resolveVariables(text: string, filePath?: string): Promise<string> {
  try {
    return (await bridge().env?.replaceVariables(text, filePath)) ?? text;
  } catch {
    return text;
  }
}

/** Calls this plugin's main-process part. */
export async function invokeMain<T>(channel: string, payload?: unknown): Promise<T> {
  const ipc = bridge().ipc;
  if (!ipc) throw new Error("Voiden's IPC bridge is not available");
  try {
    return (await ipc.invoke(channel, payload)) as T;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/No handler registered/i.test(message)) {
      throw new Error("the plugin's Node.js part isn't loaded — restart Voiden after installing or updating Auto Auth");
    }
    // Electron prefixes errors from the main process; keep only the message.
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
}

export async function getSetting<T>(context: PluginContext, key: string, fallback: T): Promise<T> {
  try {
    const value = await context.settings.get<T>(key);
    return value === undefined || value === null || value === "" ? fallback : value;
  } catch {
    return fallback;
  }
}

/** A module Voiden shares with plugins on window.__voiden_shims__. */
export function hostModule<T>(name: string): T | undefined {
  return (window.__voiden_shims__ ?? {})[name] as T | undefined;
}

export function toast(context: PluginContext, message: string, type: "info" | "success" | "warning" | "error" = "info") {
  try {
    context.ui.showToast?.(message, type);
  } catch {
    // Toasts are best-effort.
  }
}
