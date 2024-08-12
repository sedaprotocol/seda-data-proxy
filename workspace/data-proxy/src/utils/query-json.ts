import JSONPath from "jsonpath";
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

	const data = JSONPath.query(jsonData.value, path);

	if (!data.length) {
		return Result.err(`Quering JSON with ${path} returned null`);
	}

	return Result.ok(data[0]);
}
