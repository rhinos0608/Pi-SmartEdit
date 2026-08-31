import {
  createRpcClient,
  RPC_CHANNELS,
  LANGUAGE_INTELLIGENCE_RPC_METHODS,
  type RenamePreviewRequest,
  type RenamePreviewResponse,
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
