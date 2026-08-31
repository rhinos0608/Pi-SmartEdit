import {
  createRpcClient,
  RPC_CHANNELS,
  LANGUAGE_INTELLIGENCE_RPC_METHODS,
  type RenamePreviewRequest,
  type RenamePreviewResponse,
  type OrganizeImportsRequest,
  type OrganizeImportsResponse,
  type FormattingRequest,
  type FormattingResponse,
  type CodeActionRequest,
  type CodeActionResponse,
} from "@rhinos0608/pi-workspace-protocol";

type BusLike = {
  emit: (c: string, d: unknown) => void;
  on: (c: string, h: (d: unknown) => void) => () => void;
};

export async function requestRenamePreview(
  bus: BusLike,
  request: RenamePreviewRequest,
  opts?: { timeoutMs?: number },
): Promise<RenamePreviewResponse> {
  const client = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: opts?.timeoutMs ?? 5000 });
  try {
    const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, request);
    if (!reply.ok) throw new Error(reply.error ?? "rename_preview rpc failed");
    return reply.payload as RenamePreviewResponse;
  } finally {
    client.dispose();
  }
}

export async function requestOrganizeImports(
  bus: BusLike,
  request: OrganizeImportsRequest,
  opts?: { timeoutMs?: number },
): Promise<OrganizeImportsResponse> {
  const client = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: opts?.timeoutMs ?? 5000 });
  try {
    const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.organizeImports, request);
    if (!reply.ok) throw new Error(reply.error ?? "organize_imports rpc failed");
    return reply.payload as OrganizeImportsResponse;
  } finally {
    client.dispose();
  }
}

export async function requestFormatting(
  bus: BusLike,
  request: FormattingRequest,
  opts?: { timeoutMs?: number },
): Promise<FormattingResponse> {
  const client = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: opts?.timeoutMs ?? 5000 });
  try {
    const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, request);
    if (!reply.ok) throw new Error(reply.error ?? "formatting rpc failed");
    return reply.payload as FormattingResponse;
  } finally {
    client.dispose();
  }
}

export async function requestCodeAction(
  bus: BusLike,
  request: CodeActionRequest,
  opts?: { timeoutMs?: number },
): Promise<CodeActionResponse> {
  const client = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: opts?.timeoutMs ?? 5000 });
  try {
    const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, request);
    if (!reply.ok) throw new Error(reply.error ?? "code_action rpc failed");
    return reply.payload as CodeActionResponse;
  } finally {
    client.dispose();
  }
}
