/**
 * Transfer-edit facade: re-exports the frozen transfer semantics now owned
 * by `src/transfer/` (contract, resolve, plan, adapter) so existing imports
 * (`src/patch.ts`, tests) keep working unchanged.
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
export {
  adaptTransferOp,
  adaptTransferOps,
} from "./transfer/adapter.js";
