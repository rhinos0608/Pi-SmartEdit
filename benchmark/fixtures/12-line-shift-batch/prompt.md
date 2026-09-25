In src/pipeline.ts make three changes and nothing else:
1. Keep the existing blank line immediately after the import. After that blank line, insert exactly:
export const PIPELINE_METADATA = {
  owner: "platform",
  version: 2,
} as const;

Keep exactly one blank line between this new block and export const STAGES.
2. Change DEFAULT_TIMEOUT_MS from 15000 to 20000.
3. Change DEFAULT_RETRIES from 2 to 3.
Preserve all other text and formatting.
