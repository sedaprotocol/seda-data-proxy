import { Effect } from "effect";
import { FailedToParseResponseBodyError, HttpClientRequestFailedError } from "../errors";

type FetchUrlInput = Parameters<typeof fetch>[0];
type FetchUrlOptions = Parameters<typeof fetch>[1];

export class HttpClientService extends Effect.Service<HttpClientService>()("HttpClientService", {
	effect: Effect.fnUntraced(function* () {
		const request = (input: FetchUrlInput, options: FetchUrlOptions) =>
			Effect.gen(function* () {
				const upstreamResponse = yield* Effect.tryPromise({
					try: async () => fetch(input, options),
					catch: (error) =>
						new HttpClientRequestFailedError({
							error,
						}),
				});

				return upstreamResponse;
			}).pipe(Effect.withSpan("executeHttp"));

		const parseBodyAsText = (response: Response) =>
			Effect.tryPromise({
				try: async () => response.text(),
				catch: (error) => new FailedToParseResponseBodyError({ error }),
			});

		return { request, parseBodyAsText };
	}),
}) {}
