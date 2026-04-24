import { Effect } from "effect";
import { JSONPath } from "jsonpath-plus";
import { QueryJsonError } from "../errors";

export const queryJson = (
	input: string | object,
	path: string,
	legacyJsonPath = true,
) =>
	Effect.gen(function* () {
		const jsonData = yield* typeof input === "string"
			? Effect.try({
					try: () => JSON.parse(input) as object,
					catch: (error) =>
						new QueryJsonError({ error: `Parsing as JSON failed: ${error}` }),
				})
			: Effect.succeed(input);

		const data: unknown = yield* Effect.try({
			try: () => JSONPath({ path, json: jsonData }),
			catch: (error) => {
				const jsonInput = JSON.stringify(input);
				return new QueryJsonError({
					error: `Could not query JSON: ${error} with input ${jsonInput.slice(0, 100)}...`,
					data: jsonInput,
				});
			},
		});

		if (!legacyJsonPath) {
			return yield* Effect.succeed(data);
		}

		if (!Array.isArray(data)) {
			const jsonInput = JSON.stringify(input);
			return yield* Effect.fail(
				new QueryJsonError({
					error: `Quering JSON with ${path} returned not an array: ${JSON.stringify(data)} with input ${jsonInput.slice(0, 100)}...`,
					data: jsonInput,
				}),
			);
		}

		if (data.length === 0) {
			const jsonInput = JSON.stringify(input);
			return yield* Effect.fail(
				new QueryJsonError({
					error: `Quering JSON with ${path} returned null with input ${jsonInput.slice(0, 100)}...`,
					data: jsonInput,
				}),
			);
		}

		return yield* Effect.succeed(data[0] as unknown);
	});
