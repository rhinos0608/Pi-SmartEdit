export const REQUIRED_HEADERS = ["content-type", "accept"] as const;

export const DEPRECATED_HEADERS = [
  "x-request-id",
  "traceparent",
  "tracestate",
] as const;

export function headerCount(): number {
  return REQUIRED_HEADERS.length + DEPRECATED_HEADERS.length;
}
