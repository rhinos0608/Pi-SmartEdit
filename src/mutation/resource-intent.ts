/** Tool-neutral resource intent used during mutation planning. */
export type MutationResourceIntentKind =
  | "mutate-existing"
  | "observe-source"
  | "create-new";

export interface MutationResourceIntent {
  readonly canonicalPath: string;
  readonly kind: MutationResourceIntentKind;
}
