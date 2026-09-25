export const activeFlags = ["checkout-v3", "search-v2"] as const;


export function isActive(flag: string): boolean {
  return activeFlags.includes(flag as (typeof activeFlags)[number]);
}
