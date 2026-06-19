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
export type { LSPServerHealth, LSPManagerOptions } from "./lsp-manager";

// Document sync
export { withOpenDocument } from "./document-sync";

// Diagnostics (post-edit checking)
export { checkPostEditDiagnostics } from "./diagnostics";
export type { Diagnostic, DiagnosticResult } from "./diagnostics";

// Semantic navigation
export {
  goToDefinitions,
  findReferences,
  getHoverInfo,
} from "./semantic-nav";
export type { Location } from "./semantic-nav";