/**
 * `auth.send()` — HTTP for auth scripts, running in Voiden's main process.
 *
 * {{variables}} are filled in from the active environment *before* the body
 * is encoded, so values with quotes, backslashes or `&` are escaped correctly
 * for JSON and form bodies.
 */

export interface SendOptions {
  method?: string;
  url: string;
  headers?: Record<string, unknown> | { key: string; value: unknown; enabled?: boolean }[];
  query?: Record<string, unknown>;
  /** JSON body; string values may contain {{variables}}. */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, unknown>;
  /** Raw body; sent as-is after {{variable}} substitution. */
  body?: string;
  contentType?: string;
  /** Default 30 000. */
  timeoutMs?: number;
  /** Default true: a non-2xx response throws with the status and body. */
  throwOnError?: boolean;
}

export interface SendResponse {
  status: number;
  ok: boolean;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  text: string;
  /** Parsed body when it's JSON, otherwise undefined. */
  json: unknown;
}

export type Resolve = (text: string) => Promise<string>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;

async function resolveDeep(value: unknown, resolve: Resolve): Promise<unknown> {
  if (typeof value === "string") return value.includes("{{") ? resolve(value) : value;
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveDeep(v, resolve)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolveDeep(v, resolve);
    return out;
  }
  return value;
}

function headerList(headers: SendOptions["headers"]): [string, unknown][] {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.filter((h) => h.enabled !== false).map((h) => [h.key, h.value]);
  return Object.entries(headers);
}

/** Builds the URL and fetch options, with every {{variable}} resolved. */
export async function buildRequest(
  options: SendOptions,
  resolve: Resolve,
): Promise<{ url: string; init: RequestInit & { headers: Record<string, string> } }> {
  if (!options || !options.url) throw new Error("auth.send: `url` is required");

  const url = new URL(await resolve(String(options.url)));
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.append(key, String(await resolveDeep(String(value), resolve)));
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of headerList(options.headers)) {
    headers[key] = String(await resolveDeep(String(value), resolve));
  }
  const hasHeader = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(await resolveDeep(options.json, resolve));
    if (!hasHeader("Content-Type")) headers["Content-Type"] = "application/json";
  } else if (options.form) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) {
      params.append(key, String(await resolveDeep(String(value), resolve)));
    }
    body = params.toString();
    if (!hasHeader("Content-Type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (options.body !== undefined) {
    body = String(await resolveDeep(String(options.body), resolve));
    if (options.contentType && !hasHeader("Content-Type")) headers["Content-Type"] = options.contentType;
  }

  const method = String(options.method ?? (body !== undefined ? "POST" : "GET")).toUpperCase();
  return { url: url.toString(), init: { method, headers, body } };
}

export async function send(options: SendOptions, resolve: Resolve, fetchImpl: Fetch): Promise<SendResponse> {
  const { url, init } = await buildRequest(options, resolve);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : String(e);
    // Show the URL as written (with {{variables}}) so no resolved secrets leak into messages.
    throw new Error(`${init.method} ${options.url} failed: ${reason}`);
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));

  const result: SendResponse = { status: response.status, ok: response.ok, headers, text, json };
  if (!response.ok && options.throwOnError !== false) {
    const detail = text ? `: ${text.slice(0, 200)}` : "";
    throw new Error(`${init.method} ${options.url} → HTTP ${response.status}${detail}`);
  }
  return result;
}
