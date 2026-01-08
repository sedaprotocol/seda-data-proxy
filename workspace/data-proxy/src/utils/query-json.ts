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
		const slicedInput = JSON.stringify(input).slice(0, 100);
		return Result.err(
			`Could not query JSON: ${data.error} with input ${slicedInput}...`,
		);
	}

	if (!Array.isArray(data.value)) {
		const slicedInput = JSON.stringify(input).slice(0, 100);
		return Result.err(
			`Quering JSON with ${path} returned not an array: ${JSON.stringify(data.value)} with input ${slicedInput}...`,
		);
	}

	if (data.value.length === 0) {
		const slicedInput = JSON.stringify(input).slice(0, 100);
		return Result.err(
			`Quering JSON with ${path} returned null with input ${slicedInput}...`,
		);
	}

	return Result.ok(data.value[0]);
}
