/** Path helpers for the main-process side (real file system paths). */

import path from "node:path";

/** True when `child` is `parent` or inside it. Both should be real (symlink-free) paths. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The form of a file path used to look it up among approved files. Windows
 * file names are case-insensitive, and Node keeps a path's case as the script
 * wrote it (`require("./Helper")`), so there the lookup ignores case.
 */
export const fileKey = (file: string): string => (process.platform === "win32" ? file.toLowerCase() : file);
