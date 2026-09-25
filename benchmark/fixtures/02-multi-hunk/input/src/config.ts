export const DEFAULT_TIMEOUT_MS = 5000;

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export function retryPolicy(): RetryPolicy {
  return {
    maxAttempts: 3,
    backoffMs: 250,
  };
}

export function timeoutLabel(): string {
  return "timeout=" + DEFAULT_TIMEOUT_MS + "ms";
}
