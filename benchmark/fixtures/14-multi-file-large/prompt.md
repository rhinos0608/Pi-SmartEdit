In src/client.ts, src/server.ts, and src/worker.ts, replace each entire REQUEST_HEADERS list with exactly:
export const REQUEST_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
] as const;
Do not modify src/example.ts or any ROLE/function text.
