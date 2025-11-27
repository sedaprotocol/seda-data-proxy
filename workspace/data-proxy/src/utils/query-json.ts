import { trySync } from "@seda-protocol/utils";
import { JSONPath } from "jsonpath-plus";
import { Result } from "true-myth";

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

	// biome-ignore lint/suspicious/noExplicitAny: JSONPath returns any
	const data: Result<any, Error> = trySync(() =>
		JSONPath({ path, json: jsonData.value }),
	);

	if (data.isErr) {
		return Result.err(`Could not query JSON: ${data.error}`);
	}

	if (!Array.isArray(data.value)) {
		return Result.err(
			`Quering JSON with ${path} returned not an array: ${JSON.stringify(data.value)}`,
		);
	}

	if (data.value.length === 0) {
		return Result.err(`Quering JSON with ${path} returned null`);
	}

	return Result.ok(data.value[0]);
}
