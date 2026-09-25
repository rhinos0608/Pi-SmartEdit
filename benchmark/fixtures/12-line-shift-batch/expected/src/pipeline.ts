import { runStage } from "./runtime";

export const PIPELINE_METADATA = {
  owner: "platform",
  version: 2,
} as const;

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

export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_RETRIES = 3;
