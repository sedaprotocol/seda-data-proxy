import type { PythLazerClient } from "@pythnetwork/pyth-lazer-sdk";
import { Effect, Option } from "effect";
import { FailedToGetSymbolPriceIdError } from "./errors";

export const getPriceIdBySymbol = (symbol: string, client: PythLazerClient) => {
	return Effect.gen(function* () {
		const symbols = yield* Effect.tryPromise({
			try: () =>
				client.getSymbols({
					query: symbol,
				}),
			catch: (error) => new FailedToGetSymbolPriceIdError({ error }),
		});

		if (symbols.length === 0) {
			return yield* Effect.fail(
				new FailedToGetSymbolPriceIdError({
					error: `Symbol not found: ${symbol}`,
				}),
			);
		}

		const priceFeedId = Option.fromNullable(
			symbols.find((s) => s.symbol === symbol)?.pyth_lazer_id,
		);

		if (Option.isNone(priceFeedId)) {
			return yield* Effect.fail(
				new FailedToGetSymbolPriceIdError({
					error: `Symbol not found: ${symbol}`,
				}),
			);
		}

		return yield* Effect.succeed(priceFeedId.value);
	});
};
