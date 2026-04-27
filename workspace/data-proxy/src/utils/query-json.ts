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
				return new QueryJsonError({
					error: `JSONPath ${path} could not be evaluated: ${error}`,
					data: JSON.stringify(input),
				});
			},
		});

		if (!legacyJsonPath) {
			return yield* Effect.succeed(data);
		}

		if (!Array.isArray(data)) {
			return yield* Effect.fail(
				new QueryJsonError({
					error: `JSONPath ${path} did not return an array`,
					data: JSON.stringify(input),
				}),
			);
		}

		if (data.length === 0) {
			return yield* Effect.fail(
				new QueryJsonError({
					error: `JSONPath ${path} returned null`,
					data: JSON.stringify(input),
				}),
			);
		}

		return yield* Effect.succeed(data[0] as unknown);
	});
