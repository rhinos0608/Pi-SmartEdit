/**
 * Runtime mode for Smart Edit.
 *
 * Default behavior keeps the tool on the oldText/newText fuzzy-matching path.
 * Hashline editing is opt-in and treated as experimental.
 */

import { loadConfig } from "./config/schema.js";

export interface SmartEditRuntimeConfig {
  useHashlineEditing: boolean;
  allowFuzzyMatching: boolean;
}

export function getSmartEditRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): SmartEditRuntimeConfig {
  const config = loadConfig(env);
  return {
    useHashlineEditing: config.useHashlineEditing,
    allowFuzzyMatching: config.allowFuzzyMatching,
  };
}

export function parseBooleanEnv(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
