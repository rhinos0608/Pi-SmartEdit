export const activeFlags = ["checkout-v3", "search-v2"] as const;

// BEGIN retired experiment flags
export const legacyFlag01 = "retired-01";
export const legacyFlag02 = "retired-02";
export const legacyFlag03 = "retired-03";
export const legacyFlag04 = "retired-04";
export const legacyFlag05 = "retired-05";
export const legacyFlag06 = "retired-06";
export const legacyFlag07 = "retired-07";
export const legacyFlag08 = "retired-08";
export const legacyFlag09 = "retired-09";
export const legacyFlag10 = "retired-10";
export const legacyFlag11 = "retired-11";
export const legacyFlag12 = "retired-12";
export const legacyFlag13 = "retired-13";
export const legacyFlag14 = "retired-14";
export const legacyFlag15 = "retired-15";
export const legacyFlag16 = "retired-16";
export const legacyFlag17 = "retired-17";
export const legacyFlag18 = "retired-18";
export const legacyFlag19 = "retired-19";
export const legacyFlag20 = "retired-20";
export const legacyFlag21 = "retired-21";
export const legacyFlag22 = "retired-22";
export const legacyFlag23 = "retired-23";
export const legacyFlag24 = "retired-24";
export const legacyFlag25 = "retired-25";
export const legacyFlag26 = "retired-26";
export const legacyFlag27 = "retired-27";
export const legacyFlag28 = "retired-28";
export const legacyFlag29 = "retired-29";
export const legacyFlag30 = "retired-30";
export const legacyFlag31 = "retired-31";
export const legacyFlag32 = "retired-32";
// END retired experiment flags

export function isActive(flag: string): boolean {
  return activeFlags.includes(flag as (typeof activeFlags)[number]);
}
