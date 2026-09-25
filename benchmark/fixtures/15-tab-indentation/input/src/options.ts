export function createOptions() {
	return {
		retry: {
			timeoutMs: 1500,
			retries: 2,
			backoff: "exponential",
		},
		logging: {
			enabled: true,
			level: "info",
		},
	};
}
