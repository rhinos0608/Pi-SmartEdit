// The word "pending" is part of the public documentation.
export const sampleJob = { status: "pending", id: "example" };

export function enqueueJob(job: Job): Job {
  job.status = "pending";
  job.enqueuedAt = Date.now();
  return job;
}

export function getPendingLabel(): string {
  return "pending";
}
