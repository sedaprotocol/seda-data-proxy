import { Data, Effect } from "effect";
import { mergeUrlSearchParams } from "./search-params";

export class FailedToParseTargetUrlError extends Data.TaggedError(
	"FailedToParseTargetUrlError",
)<{ error: string | unknown }> {
	message = `Failed to parse target URL: ${this.error}`;
}

export const injectSearchParamsInUrl = (
	targetUrl: string,
	searchParams: URLSearchParams,
) =>
	Effect.gen(function* () {
		const target = yield* Effect.try({
			try: () => new URL(targetUrl),
			catch: (error) => new FailedToParseTargetUrlError({ error }),
		});

		const finalSearchParams = mergeUrlSearchParams(
			searchParams,
			target.searchParams,
		);

		target.search = finalSearchParams.toString();

		return target;
	});
