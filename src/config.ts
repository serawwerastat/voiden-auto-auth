/**
 * The auth config file (default `.voiden-auth/auth.yaml`) and request matching.
 *
 *   services:
 *     - name: my-api
 *       match: "{{api_url}}"            # requests whose URL starts with this
 *       folder: Some/Folder             # …and/or whose file is in this folder
 *       script: .voiden-auth/my-api.js
 *       header: Authorization           # optional
 *       enabled: true                   # optional
 *
 * A bare top-level list (without `services:`) is accepted too.
 */

import { toForwardSlashes } from "./shared/paths";

export interface ServiceRule {
  name: string;
  /** URL prefix, may contain {{variables}}. Empty = any URL. */
  match: string;
  /** Folder relative to the project root, forward slashes. Empty = any folder. */
  folder: string;
  /** Script path relative to the project root. */
  script: string;
  /** Header used for `bearer` / `token` results. */
  header: string;
  enabled: boolean;
}

export const DEFAULT_HEADER = "Authorization";
const trimSlashes = (p: string) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "");

export function parseConfig(text: string, parseYaml: (text: string) => unknown): ServiceRule[] {
  if (!text.trim()) return [];
  const doc = parseYaml(text);
  const list = Array.isArray(doc) ? doc : (doc as { services?: unknown } | null)?.services ?? [];
  if (!Array.isArray(list)) throw new Error("`services` must be a list");

  return list.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const name = String(s.name ?? `service${i + 1}`);
    if (!s.script) throw new Error(`service "${name}" has no script`);
    if (!s.match && !s.folder) throw new Error(`service "${name}" needs a match or a folder`);
    return {
      name,
      match: s.match ? String(s.match) : "",
      folder: s.folder ? trimSlashes(toForwardSlashes(String(s.folder))) : "",
      script: trimSlashes(toForwardSlashes(String(s.script))),
      header: s.header ? String(s.header) : DEFAULT_HEADER,
      enabled: s.enabled !== false,
    };
  });
}

const withScheme = (url: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);

/** True when `url` is `prefix` or below it (path, query or fragment). */
export function urlStartsWith(url: string, prefix: string): boolean {
  const u = withScheme(url).toLowerCase();
  const p = withScheme(prefix).toLowerCase().replace(/\/+$/, "");
  return u === p || u.startsWith(`${p}/`) || u.startsWith(`${p}?`) || u.startsWith(`${p}#`);
}

/** True when `file` (project-relative) is inside `folder`. Case-insensitive. */
export function fileInFolder(file: string, folder: string): boolean {
  const f = file.toLowerCase();
  const d = folder.toLowerCase();
  return f.startsWith(`${d}/`);
}

/**
 * The first enabled rule matching the request. `resolve` fills in
 * {{variables}}; a `match` whose variables aren't set in the current
 * environment never matches.
 */
export async function pickService(
  rules: ServiceRule[],
  request: { url: string; file: string },
  resolve: (text: string) => Promise<string>,
): Promise<ServiceRule | null> {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.folder && !fileInFolder(request.file, rule.folder)) continue;
    if (rule.match) {
      const prefix = (await resolve(rule.match)).trim();
      if (!prefix || prefix.includes("{{")) continue;
      if (!urlStartsWith(request.url, prefix)) continue;
    }
    return rule;
  }
  return null;
}
