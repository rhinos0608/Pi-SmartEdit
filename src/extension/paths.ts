import { resolve } from "path";

export function resolveEditPath(cwd: string, targetPath: string): string {
  return resolve(cwd, targetPath);
}
