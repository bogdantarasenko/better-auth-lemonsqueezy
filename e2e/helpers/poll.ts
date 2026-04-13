/**
 * Poll a condition function until it returns a truthy value or times out.
 */
export async function poll<T>(
	fn: () => Promise<T | null | undefined>,
	opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
	const { timeoutMs = 30_000, intervalMs = 1_000, label = "poll" } = opts;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const result = await fn();
		if (result) return result;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}
