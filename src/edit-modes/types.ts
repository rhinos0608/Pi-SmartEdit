import type { EditMode } from "@rhinos0608/pi-workspace-protocol";
import type { EditRequest } from "../edit-contract.js";

export interface EditModeSpec {
    readonly id: EditMode;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    validate(input: unknown): { ok: true; value: EditRequest } | { ok: false; error: string };
    prepareArguments(args: Record<string, unknown>): Record<string, unknown>;
}
