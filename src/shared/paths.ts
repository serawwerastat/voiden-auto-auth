/** Path helpers shared by both parts of the plugin. */

export const toForwardSlashes = (p: string): string => p.replace(/\\/g, "/");

/** `absolute` relative to `base` (case-insensitive, for Windows); `absolute` itself when outside. */
export function relativeTo(base: string, absolute: string): string {
  const b = toForwardSlashes(base).replace(/\/+$/, "");
  const a = toForwardSlashes(absolute);
  return b && a.toLowerCase().startsWith(`${b.toLowerCase()}/`) ? a.slice(b.length + 1) : a;
}

export function joinPath(base: string, relative: string): string {
  return `${toForwardSlashes(base).replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
}
