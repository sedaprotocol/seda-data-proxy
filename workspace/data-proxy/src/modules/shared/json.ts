export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `null` for invalid JSON, non-objects, and arrays. */
export const parseJsonRecord = (
	raw: string,
): Record<string, unknown> | null => {
	try {
		const json: unknown = JSON.parse(raw);
		return isRecord(json) ? json : null;
	} catch {
		return null;
	}
};

/** Walks a payload that is either one object or an array of objects, skipping
 * items that are not objects or that `map` rejects. */
export const mapDataItems = <T>(
	data: unknown,
	map: (item: Record<string, unknown>) => T | null,
): T[] => {
	const items = Array.isArray(data) ? data : isRecord(data) ? [data] : [];
	const out: T[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const mapped = map(item);
		if (mapped !== null) out.push(mapped);
	}
	return out;
};
