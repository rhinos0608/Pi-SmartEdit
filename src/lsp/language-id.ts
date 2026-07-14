/**
 * Detect the LSP language ID from a file path extension.
 * Returns null for unsupported file types.
 */
export function detectLanguageFromExtension(filePath: string): string | null {
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".ts") || ext.endsWith(".mts") || ext.endsWith(".cts")) return "typescript";
  if (ext.endsWith(".tsx")) return "typescriptreact";
  if (ext.endsWith(".js") || ext.endsWith(".mjs") || ext.endsWith(".cjs")) return "javascript";
  if (ext.endsWith(".jsx")) return "javascriptreact";
  if (ext.endsWith(".json")) return "json";
  if (ext.endsWith(".md")) return "markdown";
  if (ext.endsWith(".css")) return "css";
  if (ext.endsWith(".html")) return "html";
  if (ext.endsWith(".py")) return "python";
  if (ext.endsWith(".rb")) return "ruby";
  if (ext.endsWith(".go")) return "go";
  if (ext.endsWith(".rs")) return "rust";
  if (ext.endsWith(".java")) return "java";
  return null;
}
