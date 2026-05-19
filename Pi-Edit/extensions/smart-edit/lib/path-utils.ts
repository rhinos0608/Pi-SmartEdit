/**
 * Path resolution utility — mirrors Pi's built-in path-utils.
 */

import { resolve, isAbsolute } from "path";

export function resolveToCwd(path: string, cwd: string): string {
  if (!path) throw new Error(`resolveToCwd: path must not be empty`);
  return isAbsolute(path) ? path : resolve(cwd, path);
}
