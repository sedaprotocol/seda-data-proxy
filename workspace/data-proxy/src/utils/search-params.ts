export function createUrlSearchParams(
	queryParams: Record<string, string | undefined>,
): URLSearchParams {
	const result = new URLSearchParams();

	for (const [key, value] of Object.entries(queryParams)) {
		result.append(key, value ?? "");
	}

	return result;
}

export function mergeUrlSearchParams(a: URLSearchParams, b: URLSearchParams) {
	const result = new URLSearchParams(a);
	b.forEach((value, key) => result.append(key, value));

	return result;
}
