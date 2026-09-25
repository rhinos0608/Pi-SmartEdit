export const stagingWorker = {
  endpoint: "/jobs",
  timeoutMs: 1000,
  retries: 2,
  concurrency: 8,
  enabled: true,
};

export const productionWorker = {
  endpoint: "/jobs",
  timeoutMs: 1000,
  retries: 2,
  concurrency: 8,
  enabled: true,
};

export const canaryWorker = {
  endpoint: "/jobs",
  timeoutMs: 1000,
  retries: 2,
  concurrency: 8,
  enabled: true,
};
