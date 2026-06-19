// Simple glob matcher supporting * (non-slash wildcard), ? (single-character non-slash),
// and double-star directory prefixes.
// Does NOT support brace expansion or character classes.
// Uses a Set of special-regex characters to avoid inline regex issues with esbuild.

const REGEX_SPECIAL = new Set([".", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

// Match a simple glob pattern against a file path.
// Supports **\/ (recursive directory prefix), ** (match everything),
// * (single-segment wildcard), ? (single char).
export function simpleGlobMatch(glob: string, path: string): boolean {
  const normalised = path.split("\\").join("/");

  // Handle /** at the end (matches directory and all subfiles)
  let globBody = glob;
  let endsWithStarSlashStar = false;
  if (glob.endsWith("/**")) {
    endsWithStarSlashStar = true;
    globBody = glob.slice(0, -3);
  }

  // Build regex from simple glob pattern
  let regexStr = "^";
  let i = 0;
  while (i < globBody.length) {
    if (globBody.startsWith("**/", i)) {
      regexStr += "(?:.*\\/)?";
      i += 3;
    } else if (globBody.startsWith("**", i)) {
      // ** not followed by /
      regexStr += ".*";
      i += 2;
    } else if (globBody[i] === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (globBody[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      const ch = globBody[i];
      if (REGEX_SPECIAL.has(ch)) {
        regexStr += "\\" + ch;
      } else {
        regexStr += ch;
      }
      i++;
    }
  }

  if (endsWithStarSlashStar) {
    regexStr += "(?:\\/.*)?";
  }

  regexStr += "$";

  try {
    return new RegExp(regexStr).test(normalised);
  } catch {
    return false;
  }
}
