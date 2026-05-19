/**
 * Runtime mode for Smart Edit.
 *
 * Default behavior keeps the tool on the oldText/newText fuzzy-matching path.
 * Hashline editing is opt-in and treated as experimental.
 */

export interface SmartEditRuntimeConfig {
  useHashlineEditing: boolean;
}

const HASHLINE_ENV_VARS = [
  "SMART_EDIT_USE_HASHLINE_EDITING",
  "SMART_EDIT_HASHLINE_EXPERIMENTAL",
] as const;

// NOTE: Environment variable precedence — the first matching env var in the array wins.
// Earlier entries take priority over later ones. If no env var is set, the
// default (useHashlineEditing: false) is returned.
export function getSmartEditRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): SmartEditRuntimeConfig {
  for (const key of HASHLINE_ENV_VARS) {
    const raw = env[key];
    if (raw == null) continue;
    return {
      useHashlineEditing: parseBooleanEnv(raw),
    };
  }

  return { useHashlineEditing: false };
}

export function parseBooleanEnv(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
