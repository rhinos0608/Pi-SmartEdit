import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import type { PlannedRename } from "./positional-planner.js";

export interface CachedPreview {
  previewId: string;
  createdAt: number;
  expiresAt: number;
  workspaceEdit: LspWorkspaceEdit;
  plannedRename: PlannedRename;
  filePath: string;
  line: number;
  character: number;
  newName: string;
  serverDescriptorId?: string;
}

export class RenamePreviewCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly map = new Map<string, CachedPreview>();

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? 300_000;
    this.maxEntries = opts?.maxEntries ?? 16;
  }

  store(
    workspaceEdit: LspWorkspaceEdit,
    plannedRename: PlannedRename,
    meta: { filePath: string; line: number; character: number; newName: string; serverDescriptorId?: string },
  ): string {
    const previewId = crypto.randomUUID();
    const createdAt = Date.now();
    const entry: CachedPreview = {
      previewId,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      workspaceEdit,
      plannedRename,
      filePath: meta.filePath,
      line: meta.line,
      character: meta.character,
      newName: meta.newName,
      ...(meta.serverDescriptorId ? { serverDescriptorId: meta.serverDescriptorId } : {}),
    };
    // Evict oldest if at capacity
    if (this.map.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.map) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.map.delete(oldestKey);
    }
    this.map.set(previewId, entry);
    return previewId;
  }

  get(previewId: string): CachedPreview | null {
    const entry = this.map.get(previewId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(previewId);
      return null;
    }
    return entry;
  }

  delete(previewId: string): void {
    this.map.delete(previewId);
  }

  size(): number {
    // purge expired before counting
    for (const [k, v] of [...this.map.entries()]) {
      if (Date.now() > v.expiresAt) this.map.delete(k);
    }
    return this.map.size;
  }
}

export const globalRenamePreviewCache = new RenamePreviewCache();
