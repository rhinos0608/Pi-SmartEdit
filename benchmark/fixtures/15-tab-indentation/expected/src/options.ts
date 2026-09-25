export function createOptions() {
	return {
		retry: {
			timeoutMs: 2500,
			retries: 2,
			jitter: true,
			backoff: "exponential",
		},
		logging: {
			enabled: true,
			level: "info",
		},
	};
}
