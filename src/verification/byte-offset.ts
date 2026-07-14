/**
 * Compute 1-based line number for a byte offset in UTF-8 content.
 * Line 1 is first line.
 */
export function byteOffsetToLine(content: string, byteOffset: number): number {
  if (byteOffset <= 0) return 1;

  const buffer = Buffer.from(content, "utf8");
  const maxOffset = Math.min(byteOffset, buffer.length);

  let line = 1;
  for (let i = 0; i < maxOffset; i++) {
    if (buffer[i] === 0x0A) {
      // '\n' in UTF-8
      line++;
    }
  }
  return line;
}
