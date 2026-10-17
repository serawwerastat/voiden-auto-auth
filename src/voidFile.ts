/**
 * Reading the request URL out of a saved `.void` file, for the status bar.
 * (Requests being *sent* use the live URL from Voiden's pipeline instead.)
 *
 * Supports the URL blocks of Voiden's protocol plugins:
 *   REST       - type: url   / content: …
 *   GraphQL    - type: gqlurl / content: …
 *   WebSocket  - type: surl  / content: …
 */
export function parseRequestUrl(text: string): string | null {
  const m = /type:\s*["']?(?:url|gqlurl|surl)["']?\s*\n(?:[ \t]+.*\n)*?[ \t]*content:\s*(.+)/.exec(text);
  if (!m) return null;
  const url = m[1].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return url || null;
}
