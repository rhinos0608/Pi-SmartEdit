/**
 * Path resolution utility — mirrors Pi's built-in path-utils.
 */

import { resolve, isAbsolute } from "path";

export function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
