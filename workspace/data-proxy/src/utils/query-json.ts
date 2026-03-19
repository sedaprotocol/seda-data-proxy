import { trySync } from "@seda-protocol/utils";
import { Data, Effect, Match } from "effect";
import { JSONPath } from "jsonpath-plus";
import { Result } from "true-myth";

export class QueryJsonError extends Data.TaggedError("QueryJsonError")<{
	error: string | unknown;
	type?: "config" | "header";
	status?: number;
}> {
	message = `Query JSON (originator: ${this.type ?? "unknown"}) error: ${this.error} `;
}

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
				const slicedInput = JSON.stringify(input).slice(0, 100);
				return new QueryJsonError({
					error: `Could not query JSON: ${error} with input ${slicedInput}...`,
				});
			},
		});

		if (!legacyJsonPath) {
			return yield* Effect.succeed(data);
		}

		if (!Array.isArray(data)) {
			const slicedInput = JSON.stringify(input).slice(0, 100);
			return yield* Effect.fail(
				new QueryJsonError({
					error: `Quering JSON with ${path} returned not an array: ${JSON.stringify(data)} with input ${slicedInput}...`,
				}),
			);
		}

		if (data.length === 0) {
			const slicedInput = JSON.stringify(input).slice(0, 100);
			return yield* Effect.fail(
				new QueryJsonError({
					error: `Quering JSON with ${path} returned null with input ${slicedInput}...`,
				}),
			);
		}

		return yield* Effect.succeed(data[0] as unknown);
	});
