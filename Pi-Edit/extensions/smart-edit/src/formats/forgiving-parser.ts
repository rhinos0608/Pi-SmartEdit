/**
 * Forgiving JSON parser — SmallCode-inspired repair strategies for tool-call inputs.
 *
 * Small models (7B-class) often produce *almost* correct JSON. Rather than
 * rejecting malformed input, this module runs a 7-strategy pipeline adapted
 * from SmallCode's repairJson + fuzzy key matching, plus the existing
 * smart-edit repair strategies.
 *
 * Strategy pipeline:
 *   1. As-is parse
 *   2. Trailing-comma fix (remove comma before } or ])
 *   3. Wrap in braces if missing outer { }
 *   4. Strip markdown code fences (```json ... ```)
 *   5. Extract first { ... } block
 *   6. Literal-newline escape inside string values
 *   7. Unbalanced brace fix (append missing closing braces)
 *
 * After structural repair, applies Levenshtein fuzzy-key matching to
 * correct parameter names against a known schema.
 */

// ─── Public API ──────────────────────────────────────────────────────

export interface RepairResult {
  /** Parsed object, undefined if all strategies failed */
  value: unknown;
  /** Which strategy succeeded (0 = as-is, 1 = trailing-comma, etc.) */
  strategy: number;
  /** Whether fuzzy key renaming was applied */
  fuzzyKeysApplied: boolean;
  /** Keys that were renamed (original → schema name) */
  fuzzyRenames: Record<string, string>;
}

/**
 * Known parameter schemas for fuzzy key matching.
 * Keys are tool/component names, values are arrays of expected parameter names.
 */
export type KnownSchema = Record<string, string[]>;

function parseJson(input: string): unknown {
  return JSON.parse(input) as unknown;
}

// ─── Strategy implementations ────────────────────────────────────────

/**
 * Levenshtein edit distance between two strings.
 * Adapted from SmallCode's editDistance implementation.
 */
export function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

/**
 * Find a fuzzy key match for a target parameter name within a set of keys.
 * Applies normalization (lowercase, strip underscores/hyphens), substring
 * matching, and Levenshtein distance ≤ 2.
 * Returns the matched key or null.
 */
function findFuzzyKey(
  keys: Set<string>,
  target: string,
): string | null {
  const targetLower = target.toLowerCase().replace(/[_-]/g, "");

  // Pass 1: exact matches (prefer raw, then normalized)
  for (const key of keys) {
    if (key === target) return key;
  }
  for (const key of keys) {
    const keyLower = key.toLowerCase().replace(/[_-]/g, "");
    if (keyLower === targetLower) return key;
  }

  // Pass 2: substring containment (only if no exact match)
  // Require substring match to be at least 50% of the longer string
  for (const key of keys) {
    const keyLower = key.toLowerCase().replace(/[_-]/g, "");
    const longer = keyLower.length > targetLower.length ? keyLower : targetLower;
    const shorter = keyLower.length > targetLower.length ? targetLower : keyLower;
    if (longer.includes(shorter) && shorter.length >= longer.length * 0.5) {
      return key;
    }
  }

  // Pass 3: Levenshtein distance ≤ 2
  let bestMatch: string | null = null;
  let bestDistance = Infinity;
  for (const key of keys) {
    const keyLower = key.toLowerCase().replace(/[_-]/g, "");
    const dist = editDistance(keyLower, targetLower);
    if (dist <= 2 && dist < bestDistance) {
      bestDistance = dist;
      bestMatch = key;
    }
  }

  return bestMatch;
}

/**
 * Attempt to repair a malformed JSON string using all available strategies.
 *
 * Returns a RepairResult with the parsed value and metadata about which
 * strategy succeeded. value is undefined if all strategies fail.
 */
export function repairJson(
  raw: string,
  knownSchema?: KnownSchema,
): RepairResult {
  const renames: Record<string, string> = {};

  // Strip BOM at the start
  const input = raw.replace(/^\uFEFF/, '');

  // Strategy 1: As-is
  try {
    const value = parseJson(input);
    return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 0, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
  } catch { /* fall through */ }

  // Strategy 2: Fix trailing comma before } or ]
  try {
    const fixed = input.replace(/,\s*([}\]])/g, "$1");
    if (fixed !== input) {
      const value = parseJson(fixed);
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 2, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    }
  } catch { /* fall through */ }

  // Strategy 3: Wrap in braces if missing
  const trimmed = raw.trim();
  if (trimmed.length > 0 && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    try {
      const value = parseJson("{" + trimmed + "}");
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 3, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    } catch { /* fall through */ }
    try {
      const value = parseJson("[" + trimmed + "]");
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 3, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    } catch { /* fall through */ }
  }

  // Strategy 4: Strip markdown code fences
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  if (cleaned !== trimmed) {
    try {
      const value = parseJson(cleaned);
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 4, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    } catch { /* fall through */ }
  }

  // Strategy 5: Extract first { ... } or [ ... ] block.
  // Try array first — more specific and prevents inner object from
  // matching when the outer structure is an array.
  const arrMatch = trimmed.match(/(\[[\s\S]*\])/);
  if (arrMatch) {
    try {
      const value = parseJson(arrMatch[1]);
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 5, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    } catch { /* fall through */ }
  }
  const objMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try {
      const value = parseJson(objMatch[1]);
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 5, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    } catch { /* fall through */ }
  }

  // Strategy 6: Fix literal newlines inside string values
  try {
    const repaired = trimmed.replace(
      /"(?:[^"\\]|\\.)*"/gs,
      (match) => {
        if (match.includes("\n") || match.includes("\r")) {
          return match.replace(/\r?\n/g, "\\n").replace(/\r/g, "\\r");
        }
        return match;
      },
    );
    if (repaired !== trimmed) {
      const value = parseJson(repaired);
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 6, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    }
  } catch { /* fall through */ }

  // Strategy 7: Fix unbalanced braces (append missing closing braces)
  const mustClose: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of trimmed) {
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") { depth++; mustClose.push(ch === "{" ? "}" : "]"); }
    if (ch === "}" || ch === "]") {
      const expected = mustClose[mustClose.length - 1];
      if (expected !== ch) {
        // Mismatched closer — abort strategy 7, fall through to next strategy
        break;
      }
      depth--;
      mustClose.pop();
    }
  }
  if (mustClose.length > 0) {
    try {
      const value = parseJson(trimmed + mustClose.reverse().join(""));
      return { value: applyFuzzyKeys(value, knownSchema, renames), strategy: 7, fuzzyKeysApplied: Object.keys(renames).length > 0, fuzzyRenames: renames };
    } catch { /* fall through */ }
  }

  return { value: undefined, strategy: -1, fuzzyKeysApplied: false, fuzzyRenames: {} };
}

/**
 * Apply fuzzy key matching to an object recursively.
 * Renames keys that closely match known schema parameter names.
 */
function applyFuzzyKeys(
  value: unknown,
  knownSchema: KnownSchema | undefined,
  renames: Record<string, string>,
): unknown {
  if (!knownSchema || !value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) =>
      applyFuzzyKeys(item, knownSchema, renames),
    );
  }

  const obj = value as Record<string, unknown>;
  const existingKeys = new Set(Object.keys(obj));

  // Try to find a matching schema by intersecting keys.
  // When no schema matches by exact overlap, fall back to trying all
  // schema keys for fuzzy matching.
  let matchedSchema: string[] | null = null;
  for (const [, schemaKeys] of Object.entries(knownSchema)) {
    const overlap = schemaKeys.filter((k) => existingKeys.has(k)).length;
    if (overlap >= 1) {
      matchedSchema = schemaKeys;
      break;
    }
  }

  // If no schema matched by exact overlap, try fuzzy matching against all schema keys.
  // This handles the case where a nested object has keys like "old_text" that
  // should match schema keys like "oldText".
  const schemaKeysToTry = matchedSchema ?? Object.values(knownSchema).flat();

  for (const schemaKey of schemaKeysToTry) {
    if (existingKeys.has(schemaKey)) continue;

    const fuzzyMatch = findFuzzyKey(existingKeys, schemaKey);
    if (fuzzyMatch) {
      renames[fuzzyMatch] = schemaKey;
      obj[schemaKey] = obj[fuzzyMatch];
      delete obj[fuzzyMatch];
      existingKeys.delete(fuzzyMatch);
      existingKeys.add(schemaKey);
    }
  }

  // Recurse into nested objects
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      obj[k] = applyFuzzyKeys(v, knownSchema, renames);
    }
  }

  return obj;
}

/**
 * Quick repair for tool-call JSON that comes as a string.
 * Optimized for the edit/write tool-call patterns.
 * Returns the parsed edits array or undefined.
 */
export function repairToolCallJson(
  raw: string,
  knownSchema?: KnownSchema,
): unknown[] | undefined {
  if (!raw || typeof raw !== "string") return undefined;

  const result = repairJson(raw, knownSchema);
  if (result.value === undefined) return undefined;

  // If the result is a single object, wrap in array
  if (!Array.isArray(result.value)) {
    if (result.value && typeof result.value === "object") {
      return [result.value];
    }
    return undefined;
  }

  return result.value as unknown[];
}

// ─── Exports for testing ─────────────────────────────────────────────

export { findFuzzyKey };
