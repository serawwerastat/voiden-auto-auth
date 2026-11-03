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

const KNOWN_OPTIONS = new Set(["method", "url", "headers", "query", "json", "form", "body", "contentType", "timeoutMs", "throwOnError"]);

/** Catches options written in Postman's pm.sendRequest format, which look valid but would be ignored. */
function checkOptions(options: SendOptions): void {
  const o = options as unknown as Record<string, unknown>;
  if ("header" in o) throw new Error("auth.send: use `headers`, not `header`");
  if (o.body !== undefined && typeof o.body !== "string") {
    throw new Error("auth.send: `body` must be a string — use `form: { key: value }` for form data or `json: {…}` for JSON");
  }
  const unknown = Object.keys(o).filter((key) => !KNOWN_OPTIONS.has(key));
  if (unknown.length) throw new Error(`auth.send: unknown option${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
}

/** Names of {{variables}} still present after resolving, i.e. not set in the active environment. */
function unresolvedNames(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((m) => m[1]);
}

const TLS_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Turns Node's generic "fetch failed" into the underlying reason
 * (DNS, refused connection, certificate, …) with a hint where one helps.
 */
export function describeNetworkError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") return `timed out after ${timeoutMs} ms`;
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
  const err = cause as Error & { code?: string };
  const code = err?.code ?? "";
  const message = err?.message ?? String(error);
  const reason = code && !message.includes(code) ? `${code}: ${message}` : message;

  if (TLS_CODES.has(code)) {
    return `${reason} — Voiden doesn't trust the server's certificate (often the server leaves out its intermediate certificate, or it's signed by a company CA). Turn on "Disable TLS verification" in Voiden's settings (search for "TLS"), or add the CA with NODE_EXTRA_CA_CERTS`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${reason} — check the host name, and whether it needs a VPN or Voiden's proxy setting`;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `${reason} — the server can't be reached; check VPN or Voiden's proxy setting`;
  }
  return reason;
}

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
  resolveVariables: Resolve,
): Promise<{ url: string; init: RequestInit & { headers: Record<string, string> } }> {
  if (!options || !options.url) throw new Error("auth.send: `url` is required");
  checkOptions(options);

  // Remember variables that stay unresolved, before any encoding hides them.
  const missing = new Set<string>();
  const resolve: Resolve = async (text) => {
    const value = await resolveVariables(text);
    unresolvedNames(value).forEach((name) => missing.add(name));
    return value;
  };
  const reportMissing = () => {
    if (missing.size) {
      throw new Error(`variable${missing.size > 1 ? "s" : ""} not set in the active environment: ${[...missing].join(", ")}`);
    }
  };

  const rawUrl = await resolve(String(options.url));
  reportMissing();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL ${options.url}`);
  }
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

  reportMissing();

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
    // Show the URL as written (with {{variables}}) so no resolved secrets leak into messages.
    throw new Error(`${init.method} ${options.url} failed: ${describeNetworkError(e, timeoutMs)}`);
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
