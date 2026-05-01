/**
 * LSP integration barrel export.
 *
 * Re-exports all LSP-related modules for convenient imports.
 */

// LSP Connection (JSON-RPC stdio transport)
export { LSPConnection } from "./lsp-connection";
export type { LSPRequest, LSPResponse, LSPNotification } from "./lsp-connection";

// LSP Manager (server lifecycle)
export { LSPManager } from "./lsp-manager";

// Diagnostics (post-edit checking)
export { checkPostEditDiagnostics } from "./diagnostics";
export type { Diagnostic, DiagnosticResult } from "./diagnostics";

// Semantic navigation
export {
  goToDefinition,
  findReferences,
  getHoverInfo,
} from "./semantic-nav";
export type { Location } from "./semantic-nav";