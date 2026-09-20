/**
 * Transfer-edit facade: re-exports the frozen transfer semantics now owned
 * by `src/transfer/` (contract, resolve, plan) so existing imports
 * (tests) keep working unchanged.
 *
 * Stage 4 hard-cut: the transfer-in-`edit` adapter is deleted. Copy/move is
 * only available through the first-class `transfer` tool
 * (`src/transfer/tool.ts`); `edit` rejects transfer-shaped payloads.
 */
export {
  type TransferRequest,
  TRANSFER_PARAMETERS,
  validateTransferRequest,
} from "./transfer/contract.js";
export {
  type ResolvedSourceRange,
  resolveSourceRange,
  resolveDestination,
  resolveTransfer,
} from "./transfer/resolve.js";
export {
  type TransferDest,
  type TransferPlan,
  type ResolvedTransfer,
  type TransferMutations,
  planTransfer,
  bindResolvedTransfer,
  planTransferMutations,
  buildTransferDescription,
  applyTransferLiteral,
  applyTransferDeleteLiteral,
  buildTransferInsertEdit,
  buildTransferDeleteEdit,
} from "./transfer/plan.js";
