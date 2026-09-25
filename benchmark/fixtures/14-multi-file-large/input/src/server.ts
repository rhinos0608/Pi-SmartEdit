export const ROLE = "server";

export const REQUEST_HEADERS = [
  "x-old-01",
  "x-old-02",
  "x-old-03",
  "x-old-04",
  "x-old-05",
  "x-old-06",
  "x-old-07",
  "x-old-08",
  "x-old-09",
  "x-old-10",
  "x-old-11",
  "x-old-12",
  "x-old-13",
  "x-old-14",
  "x-old-15",
  "x-old-16",
  "x-old-17",
  "x-old-18",
  "x-old-19",
  "x-old-20",
] as const;

export function role(): string {
  return ROLE;
}
