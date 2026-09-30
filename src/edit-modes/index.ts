import type { EditMode } from "@rhinos0608/pi-workspace-protocol";
import { loadConfig } from "../config/schema.js";
import { validateEditRequest } from "../edit-contract.js";
import type { EditModeSpec } from "./types.js";
import { textEditModeSpec } from "./text.js";
import { hashlineEditModeSpec } from "./hashline.js";

export type { EditModeSpec } from "./types.js";
export { TEXT_EDIT_PARAMETERS, TEXT_EDIT_DESCRIPTION, textEditModeSpec } from "./text.js";
export {
    HASHLINE_EDIT_PARAMETERS,
    HASHLINE_EDIT_DESCRIPTION,
    hashlineEditModeSpec,
    validateHashlineOnlyEditRequest,
} from "./hashline.js";

export function getEditModeSpec(mode: EditMode): EditModeSpec {
    return mode === "hashline" ? hashlineEditModeSpec : textEditModeSpec;
}

/** Active mode spec from operator config. */
export function getActiveEditMode(env: Record<string, string | undefined> = process.env): EditModeSpec {
    return getEditModeSpec(loadConfig(env).editMode);
}

/**
 * Internal-planner spec (see test/edit-tool-capabilities.test.ts): raw/topology and
 * structural-target dialects stay reachable via the shared validator.
 */
export function getInternalPlannerEditModeSpec(): EditModeSpec {
    return { ...textEditModeSpec, validate: validateEditRequest };
}
