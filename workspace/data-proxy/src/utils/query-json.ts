import { JSONPath } from "jsonpath-plus";
import { Result } from "true-myth";
import { trySync } from "./try";

export function queryJson(
	input: string | object,
	path: string,
): Result<unknown, string> {
	const jsonData: Result<object, unknown> =
		typeof input === "string"
			? trySync(() => JSON.parse(input))
			: Result.ok(input);

	if (jsonData.isErr) {
		return Result.err(`Parsing as JSON failed: ${jsonData.error}`);
	}

	const data = trySync(() => JSONPath({ path, json: jsonData.value }));

	if (data.isErr) {
		return Result.err(`Could not query JSON: ${data.error}`);
	}

	if (!data.value.length) {
		return Result.err(`Quering JSON with ${path} returned null`);
	}

	return Result.ok(data.value[0]);
}
