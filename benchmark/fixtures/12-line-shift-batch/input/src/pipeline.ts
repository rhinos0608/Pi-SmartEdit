import { runStage } from "./runtime";

export const STAGES = [
  "parse",
  "validate",
  "transform",
  "emit",
] as const;

export function execute(input: string): string {
  let value = input;
  for (const stage of STAGES) {
    value = runStage(stage, value);
  }
  return value;
}

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_RETRIES = 2;
