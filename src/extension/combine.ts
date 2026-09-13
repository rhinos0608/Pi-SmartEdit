import type {
  EditResult,
  EditCapability,
} from "../core/types.js";

export type ToolEditResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: EditResult["details"];
};

export function combineMultiFileEditResults(results: ToolEditResult[]): ToolEditResult {
  const details: EditResult["details"] = {};
  const diffs: string[] = [];
  const matchNotes: string[] = [];
  const conflictWarnings: string[] = [];
  const mutatedPaths = new Set<string>();
  const diagnostics: NonNullable<EditResult["details"]["diagnostics"]> = [];
  const editCapabilities = new Set<EditCapability>();
  const scopedDiagnostics: NonNullable<EditResult["details"]["scopedDiagnostics"]> = [];

  for (const result of results) {
    const childDetails = result.details;
    if (!childDetails) continue;
    if (childDetails.diff) diffs.push(childDetails.diff);
    matchNotes.push(...(childDetails.matchNotes ?? []));
    conflictWarnings.push(...(childDetails.conflictWarnings ?? []));
    for (const path of childDetails.mutatedPaths ?? []) mutatedPaths.add(path);
    diagnostics.push(...(childDetails.diagnostics ?? []));
    for (const capability of childDetails.editCapabilities ?? []) editCapabilities.add(capability);
    scopedDiagnostics.push(...(childDetails.scopedDiagnostics ?? []));
  }

  if (diffs.length > 0) details.diff = diffs.join("\n");
  if (matchNotes.length > 0) details.matchNotes = matchNotes;
  if (conflictWarnings.length > 0) details.conflictWarnings = conflictWarnings;
  if (mutatedPaths.size > 0) details.mutatedPaths = [...mutatedPaths];
  if (diagnostics.length > 0) details.diagnostics = diagnostics;
  if (editCapabilities.size > 0) details.editCapabilities = [...editCapabilities].sort();
  if (scopedDiagnostics.length > 0) details.scopedDiagnostics = scopedDiagnostics;

  return {
    content: results.flatMap((result) => result.content),
    details,
  };
}
