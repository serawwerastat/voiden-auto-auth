/**
 * The parts of Voiden's plugin APIs this plugin uses.
 *
 * Mirrors `CorePluginContext` (renderer) and `ElectronExtensionContext`
 * (main process) from `@voiden/sdk`; declared locally so the plugin
 * type-checks without the whole SDK.
 */

// ── Renderer ────────────────────────────────────────────────────────────────

/** Request as it travels through Voiden's pipeline hooks. */
export interface RequestState {
  url: string;
  method?: string;
  headers?: { key: string; value: string; enabled?: boolean }[];
  metadata?: Record<string, unknown> & { requestFilePath?: string };
}

export interface PreSendContext {
  requestState: RequestState;
}

export interface PostProcessingContext {
  requestState?: RequestState;
  responseState?: { status?: number };
}

export interface SettingsField {
  type: "text" | "number" | "select" | "toggle";
  key: string;
  label: string;
  description?: string;
  defaultValue?: string | number | boolean;
  placeholder?: string;
}

export interface PluginContext {
  pipeline: {
    registerHook(stage: string, handler: (ctx: never) => unknown, priority?: number): Promise<void>;
    unregister(): Promise<void>;
  };
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
  };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    createDirectory(path: string): Promise<void>;
  };
  project: {
    getPath?(): Promise<string | undefined>;
    getActiveProject?(): Promise<string | undefined>;
    openFile(path: string, skipJoin?: boolean): Promise<void>;
  };
  tab?: {
    getActiveTab?(): Promise<{ source?: string }>;
  };
  events?: {
    on(event: string, callback: (data: unknown) => void): () => void;
  };
  registerCommand(command: {
    id: string;
    label: string;
    description?: string;
    icon?: unknown;
    action: () => void | Promise<void>;
  }): void;
  registerStatusBarItem(item: {
    id: string;
    icon: unknown;
    label?: string;
    tooltip: string;
    position: "left" | "right";
    onClick: () => void;
  }): void;
  ui: {
    showToast?(message: string, type?: "info" | "success" | "warning" | "error"): void;
    registerSettings?(section: { id: string; title: string; icon?: unknown; fields: SettingsField[] }): void;
  };
}

export interface Plugin {
  onload(): Promise<void>;
  onunload(): Promise<void>;
  metadata: unknown;
}

/** Voiden's preload bridge (`window.electron`), the parts used here. */
export interface ElectronBridge {
  env?: { replaceVariables(text: string, requestFilePath?: string): Promise<string> };
  variables?: {
    getActiveEnvKey?(): Promise<string>;
  };
  files?: { read(path: string): Promise<string> };
  tab?: { getActiveTab?(): Promise<{ source?: string }> };
  ipc?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
}

declare global {
  interface Window {
    electron?: ElectronBridge;
    __voiden_shims__?: Record<string, unknown>;
  }
}

// ── Main process ────────────────────────────────────────────────────────────

/** Opaque IPC event Voiden passes to handlers; used to find the active project. */
export type IpcEvent = unknown;

export interface MainProcessContext {
  ipc: {
    handle(channel: string, handler: (event: IpcEvent, ...args: never[]) => unknown): void;
    removeHandler(channel: string): void;
  };
  env: {
    /** Fills in {{variables}} from the active environment. */
    replaceVariables(text: string, eventOrProjectPath: IpcEvent | string): Promise<string>;
  };
  project: {
    getActive(event?: IpcEvent): Promise<string | undefined>;
  };
}
