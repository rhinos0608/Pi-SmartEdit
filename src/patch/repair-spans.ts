/**
 * Patch repair spans — staged-to-preimage mapping and textual delta coverage.
 * Pure functions: no fs, no RPC, no transaction. Moved verbatim from
 * src/patch.ts (MS3 of patch.ts split).
 */
import type { LineRange } from "@rhinos0608/pi-workspace-protocol";

/**
 * Conservative line coverage for an arbitrary repaired candidate.  We use
 * the smallest contiguous preimage range containing the textual delta; this
 * can reject a repair that a finer diff could allow, but can never widen a
 * line-range grant.
 */
/**
 * Map a line span from staged (post-edit) coordinates back to the original
 * file's coordinates using the planner's preimage/postimage ranges. Lines
 * outside edited regions map 1:1 with the accumulated line-count delta;
 * lines inside an edited region map to that region's preimage start. Returns
 * null when the mapping cannot be established (no or mismatched planner
 * ranges) so the caller skips the repair rather than mis-authorizing it.
 */
export function mapRepairSpanToPreimage(
    span: LineRange,
    preimage: ReadonlyArray<LineRange>,
    postimage: ReadonlyArray<LineRange>,
): LineRange | null {
    if (preimage.length === 0 || preimage.length !== postimage.length) return null;
    const mapLine = (line: number): number => {
        let shift = 0;
        for (let i = 0; i < postimage.length; i++) {
            const post = postimage[i];
            const pre = preimage[i];
            if (line >= post.startLine && line <= post.endLine) return pre.startLine;
            if (line > post.endLine) shift += (pre.endLine - pre.startLine) - (post.endLine - post.startLine);
        }
        return line + shift;
    };
    return { startLine: mapLine(span.startLine), endLine: mapLine(span.endLine) };
}

export function changedLineRanges(before: string, after: string): ReadonlyArray<LineRange> {
    if (before === after) return [];
    let prefix = 0;
    const shared = Math.min(before.length, after.length);
    while (prefix < shared && before[prefix] === after[prefix]) prefix++;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd--;
        afterEnd--;
    }
    const startLine = before.slice(0, prefix).split("\n").length;
    const endLine = Math.max(startLine, before.slice(0, beforeEnd).split("\n").length);
    return [{ startLine, endLine }];
}
