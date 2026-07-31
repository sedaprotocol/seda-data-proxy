// Matches a request path against a configured route path pattern and
// captures `:param` segments into a params object (empty when none).
// Returns null when the path does not match.
export const matchRoutePath = (
	pattern: string,
	path: string,
): Record<string, string> | null => {
	const patternParts = splitPath(pattern);
	const pathParts = splitPath(path);

	if (patternParts.length !== pathParts.length) {
		return null;
	}

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
				// decodeURIComponent throws on invalid characters.
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
