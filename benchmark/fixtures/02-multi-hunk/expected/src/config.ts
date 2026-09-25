export const DEFAULT_TIMEOUT_MS = 7500;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export function retryPolicy(): RetryPolicy {
  return {
    maxAttempts: 5,
    backoffMs: 250,
  };
}

export function timeoutLabel(): string {
  return "timeout=" + DEFAULT_TIMEOUT_MS + "ms";
}
