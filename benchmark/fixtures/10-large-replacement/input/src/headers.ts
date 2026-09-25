export const REQUIRED_HEADERS = ["content-type", "accept"] as const;

export const DEPRECATED_HEADERS = [
  "x-legacy-header-01",
  "x-legacy-header-02",
  "x-legacy-header-03",
  "x-legacy-header-04",
  "x-legacy-header-05",
  "x-legacy-header-06",
  "x-legacy-header-07",
  "x-legacy-header-08",
  "x-legacy-header-09",
  "x-legacy-header-10",
  "x-legacy-header-11",
  "x-legacy-header-12",
  "x-legacy-header-13",
  "x-legacy-header-14",
  "x-legacy-header-15",
  "x-legacy-header-16",
  "x-legacy-header-17",
  "x-legacy-header-18",
  "x-legacy-header-19",
  "x-legacy-header-20",
  "x-legacy-header-21",
  "x-legacy-header-22",
  "x-legacy-header-23",
  "x-legacy-header-24",
  "x-legacy-header-25",
  "x-legacy-header-26",
  "x-legacy-header-27",
  "x-legacy-header-28",
  "x-legacy-header-29",
  "x-legacy-header-30",
] as const;

export function headerCount(): number {
  return REQUIRED_HEADERS.length + DEPRECATED_HEADERS.length;
}
