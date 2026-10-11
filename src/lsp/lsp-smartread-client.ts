import {
  createRpcClient,
  RPC_CHANNELS,
  LANGUAGE_INTELLIGENCE_RPC_METHODS,
  validateRenamePreviewRequest,
  validateRenamePreviewResponse,
  validateFormattingRequest,
  validateFormattingResponse,
  validateCodeActionRequest,
  validateCodeActionResponse,
  validateCodeActionSelection,
  type RenamePreviewRequest,
  type RenamePreviewResponse,
  type FormattingRequest,
  type FormattingResponse,
  type CodeActionRequest,
  type CodeActionResponse,
  type CodeActionSelection,
} from "@rhinos0608/pi-workspace-protocol";

type BusLike = {
  emit: (c: string, d: unknown) => void;
  on: (c: string, h: (d: unknown) => void) => () => void;
};

/** D-81: language-intelligence RPCs return SmartEdit-STAGED proposals
 *  ({ok:true, proposalId, files, diff} | {ok:false, error}). Raw
 *  workspaceEdit payloads never ride these RPCs — the protocol validators
 *  below reject them fail-closed via exact key sets. */

// organize_imports no longer exists (D-81). There is no dedicated RPC:
// callers use code_action discovery filtered to kind
// "source.organizeImports" plus an explicit selection — never auto-pick.

export async function requestRenamePreview(
  bus: BusLike,
  request: RenamePreviewRequest,
  opts?: { timeoutMs?: number },
): Promise<RenamePreviewResponse> {
  const v = validateRenamePreviewRequest(request);
  if (!v.ok) throw new Error(`invalid rename_preview request: ${v.error}`);
  const client = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: opts?.timeoutMs ?? 15000 });
  try {
    const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, request);
    if (!reply.ok) throw new Error(reply.error ?? "rename_preview rpc failed");
    const parsed = validateRenamePreviewResponse(reply.payload);
    if (!parsed.ok) throw new Error(`invalid rename_preview reply: ${parsed.error}`);
    return parsed.value;
  } finally {
    client.dispose();
  }
}

export async function requestFormatting(
  bus: BusLike,
  request: FormattingRequest,
  opts?: { timeoutMs?: number },
): Promise<FormattingResponse> {
  const v = validateFormattingRequest(request);
  if (!v.ok) throw new Error(`invalid formatting request: ${v.error}`);
  const client = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: opts?.timeoutMs ?? 15000 });
  try {
    const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, request);
    if (!reply.ok) throw new Error(reply.error ?? "formatting rpc failed");
    const parsed = validateFormattingResponse(reply.payload);
    if (!parsed.ok) throw new Error(`invalid formatting reply: ${parsed.error}`);
    return parsed.value;
  } finally {
    client.dispose();
  }
}

export async function requestCodeAction(
  bus: BusLike,
  request: CodeActionRequest,
  opts?: { timeoutMs?: number },
): Promise<CodeActionResponse> {
  const v = validateCodeActionRequest(request);
  if (!v.ok) throw new Error(`invalid code_action request: ${v.error}`);
  const client = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: opts?.timeoutMs ?? 15000 });
  try {
    const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, request);
    if (!reply.ok) throw new Error(reply.error ?? "code_action rpc failed");
    const parsed = validateCodeActionResponse(reply.payload);
    if (!parsed.ok) throw new Error(`invalid code_action reply: ${parsed.error}`);
    const resp = parsed.value;
    // Never auto-pick: a staged proposal is only valid as the answer to an
    // explicit selection, and a resolution must yield a staged proposal.
    if (request.selection == null && "proposalId" in resp) {
      throw new Error("invalid code_action reply: discovery returned a staged proposal without an explicit selection — pass selection {actionId, sourceSha256} to resolve");
    }
    if (request.selection != null && "actions" in resp) {
      throw new Error("invalid code_action reply: resolution with an explicit selection must return a staged proposal, got discovery candidates");
    }
    return resp;
  } finally {
    client.dispose();
  }
}

/** Staged proposal returned by code_action resolution. */
export type CodeActionProposal = Extract<CodeActionResponse, { readonly ok: true; readonly proposalId: string }>;

/**
 * Resolve a discovery candidate into a staged proposal. Requires the
 * caller's explicit selection {actionId, sourceSha256} — never auto-picks.
 */
export async function resolveCodeAction(
  bus: BusLike,
  request: CodeActionRequest & { selection: CodeActionSelection },
  opts?: { timeoutMs?: number },
): Promise<CodeActionProposal | Extract<CodeActionResponse, { readonly ok: false }>> {
  const sel = validateCodeActionSelection(request.selection, "CodeActionRequest.selection");
  if (!sel.ok) throw new Error(`code_action resolution requires an explicit selection: ${sel.error}`);
  const resp = await requestCodeAction(bus, request, opts);
  if (!resp.ok) return resp;
  if (!("proposalId" in resp)) throw new Error("invalid code_action reply: resolution must return a staged proposal");
  return resp;
}
