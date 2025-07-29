import { Effect } from "effect";
import logger from "../logger";
import { asyncToEffect } from "../utils/effect-utils";

export const getRpcChainId = (rpc: string) =>
	Effect.gen(function* () {
		const url = new URL("/status", rpc);
		const response = yield* asyncToEffect(fetch(url));
		const data = yield* asyncToEffect(response.json());

		return data.result.node_info.network;
	}).pipe(
		Effect.catchAll((error) => {
			logger.error(`Error while getting RPC chain id: ${error}`);
			return Effect.fail(error);
		}),
	);
