export const ROLE = "server";

export const REQUEST_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
] as const;

export function role(): string {
  return ROLE;
}
