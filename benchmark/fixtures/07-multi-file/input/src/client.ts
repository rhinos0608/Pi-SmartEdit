export const ITEMS_PATH = "/v1/items";

export function itemUrl(base: string): string {
  return base + ITEMS_PATH;
}
