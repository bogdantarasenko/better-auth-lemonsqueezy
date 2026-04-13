/** Default timeout for outbound Lemon Squeezy API requests (10 seconds) */
export const LS_API_TIMEOUT = 10_000;

/**
 * Make a fetch request to the Lemon Squeezy API with a 10-second timeout.
 * Handles rate limiting (429) and upstream errors (5xx/network) with structured error responses.
 * Returns { data } on success, or { error, code } on failure.
 */
export async function lsFetch(
	url: string,
	init: RequestInit & { headers: Record<string, string> },
): Promise<{ data?: unknown; error?: string; code?: string; status?: number }> {
	try {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(LS_API_TIMEOUT),
		});

		if (response.status === 429) {
			return {
				error: "Lemon Squeezy API rate limit exceeded",
				code: "rate_limited",
				status: 429,
			};
		}

		if (!response.ok) {
			const errorText = await response.text();
			if (response.status >= 500) {
				return {
					error: "Lemon Squeezy upstream service unavailable",
					code: "upstream_error",
					status: response.status,
				};
			}
			return {
				error: `Lemon Squeezy API error: ${response.status} ${errorText}`,
				code: "upstream_error",
				status: response.status,
			};
		}

		const data = await response.json();
		return { data };
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			return {
				error: "Lemon Squeezy API request timed out",
				code: "upstream_error",
			};
		}
		if (err instanceof TypeError) {
			// Network error
			return {
				error: "Lemon Squeezy upstream service unavailable",
				code: "upstream_error",
			};
		}
		throw err;
	}
}
