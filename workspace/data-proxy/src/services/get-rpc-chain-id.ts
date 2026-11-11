import { Effect } from "effect";
import { asyncToEffect } from "../utils/effect-utils";

export const getRpcChainId = (rpc: string) =>
	Effect.gen(function* () {
		const url = yield* Effect.try({
			try: () => new URL("/status", rpc),
			catch: (error) => error,
		});
		const response = yield* asyncToEffect(fetch(url));
		const data = yield* asyncToEffect(response.json());

		return data.result.node_info.network as string;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logError(`Error while getting RPC chain id: ${error}`);

				return yield* Effect.fail(error);
			}),
		),
	);
