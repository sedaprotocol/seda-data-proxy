export function createUrlSearchParams(
	queryParams: URLSearchParams,
	allowedQueryParams?: string[],
): URLSearchParams {
	const result = new URLSearchParams();

	// .forEach() is the only way to correctly iterate over the query params
	// without losing values that can be repeated, such as ?one=one&one=two
	queryParams.forEach((value, key) => {
		if (allowedQueryParams && !allowedQueryParams.includes(key)) {
			return;
		}

		// If the value is an array, append each value to the result
		// This is to support query params that can be repeated, such as ?one=one&one=two
		if (Array.isArray(value)) {
			for (const v of value) {
				result.append(key, v);
			}
		} else {
			result.append(key, value ?? "");
		}
	});

	return result;
}

export function mergeUrlSearchParams(a: URLSearchParams, b: URLSearchParams) {
	const result = new URLSearchParams(a);
	b.forEach((value, key) => result.append(key, value));

	return result;
}
