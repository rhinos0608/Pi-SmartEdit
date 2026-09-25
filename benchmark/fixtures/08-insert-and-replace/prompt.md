In src/parse.ts, add an empty-input guard immediately after the function opening: if (input.length === 0) return [];. Also change the split delimiter from "," to ";". Preserve existing formatting.
