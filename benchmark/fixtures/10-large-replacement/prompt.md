In src/headers.ts, replace only the DEPRECATED_HEADERS definition with exactly:
export const DEPRECATED_HEADERS = [
  "x-request-id",
  "traceparent",
  "tracestate",
] as const;
Leave REQUIRED_HEADERS and headerCount unchanged.
