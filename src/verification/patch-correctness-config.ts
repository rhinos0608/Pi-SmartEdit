/**
 * Language configuration for patch-correctness checks.
 *
 * Owns delimiter pairs, known globals, and per-language declaration
 * patterns. No check logic lives here.
 */

export interface DelimiterPair {
  readonly open: string;
  readonly close: string;
}

/**
 * Standard bracket/brace delimiter pairs used by most languages.
 * Additional language-specific pairs (begin/end etc.) are handled
 * separately via count checks rather than character-level matching.
 */
export const STANDARD_DELIMITERS: readonly DelimiterPair[] = [
  { open: "{", close: "}" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
];

/**
 * Language keyword-marker pairs (e.g., begin/end in Ruby/Pascal).
 * Each pair is counted by word-boundary word match.
 */
export interface KeywordPair {
  readonly open: string;
  readonly close: string;
}

export const RUBY_KEYWORD_PAIRS: readonly KeywordPair[] = [
  { open: "begin", close: "end" },
  { open: "do", close: "end" },
  { open: "case", close: "end" },
];

export const PASCAL_KEYWORD_PAIRS: readonly KeywordPair[] = [
  { open: "begin", close: "end" },
];

export const KNOWN_GLOBALS_TS = new Set([
  // Built-in objects
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise",
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "URIError", "EvalError", "AggregateError",
  // DOM / platform
  "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "fetch", "Request", "Response", "Headers", "URL", "URLSearchParams",
  "JSON", "Math", "Infinity", "NaN", "undefined", "null", "globalThis",
  "Buffer", "process", "__dirname", "__filename", "module", "exports",
  "require", "describe", "it", "test", "expect", "beforeEach", "afterEach",
  "before", "after", "assert",
]);

export interface LangConfig {
  /** Function/callable declaration patterns (capture group 1 = name) */
  declarationPatterns: string[];
  /** Block-comment open token */
  blockCommentOpen?: string;
  /** Block-comment close token */
  blockCommentClose?: string;
  /** Line comment prefix */
  lineComment?: string;
  /** Whether the language requires semicolons (relevant for syntaxSanity) */
  requiresSemicolons: boolean;
  /** Semicolons allowed but optional (JS/TS — don't flag missing) */
  semicolonsOptional: boolean;
  /** Delimiter keyword pairs (begin/end etc.) */
  keywordPairs: readonly KeywordPair[];
}

export function getLangConfig(languageId: string): LangConfig {
  const lang = languageId.toLowerCase();
  switch (lang) {
    case "typescript":
    case "tsx":
      return {
        declarationPatterns: [
          // function foo, const|let|var foo, class Foo, interface Foo, type Foo, enum Foo
          /\b(?:function|const|let|var|class|interface|type|enum)\s+(\w+)\b/.source,
          // abstract class, export function, export default class, etc.
          /\b(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+(\w+)\b/.source,
          // export function foo
          /\bexport\s+(?:function|const|let|var)\s+(\w+)\b/.source,
          // import { foo } from → not a declaration per se, but surfaces named bindings
          // Arrow function const|let foo = (...) => ...
          /\b(?:const|let|var)\s+(\w+)\s*[:=]/.source,
          // method shorthand in class/object: foo(...) { ... }
          /^\s*(?!(?:if|for|while|switch|catch|else|do|try|finally|with)\b)(\w+)\s*\([^)]*\)\s*[{:]/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "javascript":
    case "jsx":
      return {
        declarationPatterns: [
          /\b(?:function|const|let|var|class)\s+(\w+)\b/.source,
          /\bexport\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)\b/.source,
          /\b(?:const|let|var)\s+(\w+)\s*[:=]/.source,
          /^\s*(?!(?:if|for|while|switch|catch|else|do|try|finally|with)\b)(\w+)\s*\([^)]*\)\s*[{:]/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "python":
      return {
        declarationPatterns: [
          /\bdef\s+(\w+)\b/.source,
          /\bclass\s+(\w+)\b/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "go":
      return {
        declarationPatterns: [
          /\bfunc\s+(\w+)\b/.source,
          /\btype\s+(\w+)\s/.source,
          /\b(?:const|var)\s+(\w+)\s/.source,
          /\bstruct\s+(\w+)\s/.source,
          /\binterface\s+(\w+)\s/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "rust":
      return {
        declarationPatterns: [
          /\bfn\s+(\w+)\b/.source,
          /\bstruct\s+(\w+)\b/.source,
          /\benum\s+(\w+)\b/.source,
          /\btrait\s+(\w+)\b/.source,
          /\btype\s+(\w+)\b/.source,
          /\bconst\s+(\w+)\b/.source,
          /\bimpl\s+(\w+)/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "ruby":
      return {
        declarationPatterns: [
          /\bdef\s+(\w+)\b/.source,
          /\bclass\s+(\w+)\b/.source,
          /\bmodule\s+(\w+)\b/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: RUBY_KEYWORD_PAIRS,
      };
    case "pascal":
      return {
        declarationPatterns: [
          /\b(?:procedure|function)\s+(\w+)\b/.source,
          /\bclass\s+(\w+)\b/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: PASCAL_KEYWORD_PAIRS,
      };
    default:
      // Fallback for unknown or non-code language IDs: keep C-family
      // declaration patterns but disable semicolon enforcement.
      return {
        declarationPatterns: [
          /\b(?:function|class|struct|enum|interface|trait)\s+(\w+)\b/.source,
          // Type-like: int foo, String foo, Foo foo,
          /\b(?:\w+\s+)+(?!(?:if|for|while|switch|catch|else|do|try|finally|with)\b)(\w+)\s*\([^)]*\)\s*[{:]/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: false,
        keywordPairs: [],
      };
  }
}
