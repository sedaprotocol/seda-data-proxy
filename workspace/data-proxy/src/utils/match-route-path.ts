// Matches a request path against a configured route path pattern and
// captures :param and trailing * values provided by the path into a
// params object (empty when none).
// Returns null when the path does not match.
export const matchRoutePath = (
	pattern: string,
	path: string,
): Record<string, string> | null => {
	const patternParts = splitPath(pattern);
	const pathParts = splitPath(path);

	if (
		patternParts.length > 0 &&
		patternParts[patternParts.length - 1] === "*"
	) {
		const prefixParts = patternParts.slice(0, -1);
		if (pathParts.length < prefixParts.length) {
			return null;
		}

		const params = matchSegments(prefixParts, pathParts);
		if (params === null) {
			return null;
		}

		// Capture the remainder of the path as the `*` value.
		// Leave it URI-encoded so path remainder can be forwarded to upstream
		// as-is. Named `:param` values are decoded because they are treated as
		// data we extract and use ourselves.
		params["*"] = pathParts.slice(prefixParts.length).join("/");

		return params;
	}

	if (patternParts.length !== pathParts.length) {
		return null;
	}

	return matchSegments(patternParts, pathParts);
};

// Matches patternParts against the corresponding leading pathParts segments.
// Named `:param` values are URI-decoded; static segments must match exactly.
const matchSegments = (
	patternParts: string[],
	pathParts: string[],
): Record<string, string> | null => {
	const params: Record<string, string> = {};

	for (let i = 0; i < patternParts.length; i++) {
		const patternPart = patternParts[i];
		const pathPart = pathParts[i];

		if (patternPart.startsWith(":")) {
			const key = patternPart.slice(1);
			if (key.length === 0) {
				return null;
			}
			try {
				params[key] = decodeURIComponent(pathPart);
			} catch {
				// decodeURIComponent throws on invalid percent-encoding.
				return null;
			}
			continue;
		}

		if (patternPart !== pathPart) {
			return null;
		}
	}

	return params;
};

// Ensures a leading `/` and strips trailing `/`s (except for root `/`).
export const normalizePath = (path: string): string => {
	const withLeading = path.startsWith("/") ? path : `/${path}`;
	return withLeading.length > 1 ? withLeading.replace(/\/+$/, "") : withLeading;
};

const splitPath = (path: string): string[] => normalizePath(path).split("/");
