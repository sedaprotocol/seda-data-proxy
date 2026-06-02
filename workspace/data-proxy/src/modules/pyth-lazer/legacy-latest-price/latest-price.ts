import { tryParseSync } from "@seda-protocol/utils";
import { Clock, Effect } from "effect";
import * as v from "valibot";
import type { PythLazerModuleConfig } from "../../../config/pyth-lazer-module-config";
import { FailedToHandlePythLazerRequestError } from "../errors";
import type { CachedPriceFeed, PythLazerHandlerError } from "../types";

type LegacyLatestPriceHandlerDeps = {
	config: Pick<PythLazerModuleConfig, "maxFeedsPerRequest">;
	ensureSubscribedAndTrack: (
		priceFeedIds: number[],
		now: number,
	) => Effect.Effect<void, PythLazerHandlerError>;
	getOrWaitPrice: (
		priceFeedId: number,
	) => Effect.Effect<CachedPriceFeed, PythLazerHandlerError>;
	resolvePriceFeedIds: (
		rawTokens: string[],
	) => Effect.Effect<number[], PythLazerHandlerError>;
};

const maxTimestampUs = (timestamps: string[]) =>
	timestamps.reduce((latest, timestamp) =>
		BigInt(timestamp) > BigInt(latest) ? timestamp : latest,
	);

const LatestPriceRequestBodySchema = v.pipe(
	v.looseObject({
		priceFeedIds: v.optional(v.array(v.number())),
		priceFeedSymbols: v.optional(v.array(v.string())),
	}),
	v.check(
		(body) =>
			(body.priceFeedIds?.length ?? 0) > 0 ||
			(body.priceFeedSymbols?.length ?? 0) > 0,
		"Request body must include a non-empty priceFeedIds or priceFeedSymbols array",
	),
);

type LatestPriceRequestBody = v.InferOutput<
	typeof LatestPriceRequestBodySchema
>;

const PYTH_PRO_COMPAT_PRICE_FEED_FIELDS = [
	"bestAskPrice",
	"bestBidPrice",
	"confidence",
	"emaConfidence",
	"emaPrice",
	"fundingRate",
	"fundingRateInterval",
	"fundingTimestamp",
	"marketSession",
	"price",
	"publisherCount",
] as const;

const toPythProPriceFeed = ({ priceFeed, timestampUs }: CachedPriceFeed) => {
	const rawFeed = priceFeed as Record<string, unknown>;
	const out: Record<string, unknown> = {
		priceFeedId: priceFeed.priceFeedId,
		exponent: priceFeed.exponent,
		feedUpdateTimestamp:
			priceFeed.feedUpdateTimestamp ?? Number.parseInt(timestampUs, 10),
	};

	for (const field of PYTH_PRO_COMPAT_PRICE_FEED_FIELDS) {
		const value = rawFeed[field];
		out[field] = value ?? null;
	}

	return out;
};

const getRequestedFeedIdentifiers = (body: LatestPriceRequestBody) => {
	if (body.priceFeedIds !== undefined && body.priceFeedIds.length > 0) {
		return body.priceFeedIds.map(String);
	}

	return body.priceFeedSymbols ?? [];
};

const parseJsonBody = (body: string | undefined) =>
	Effect.try({
		try: () => JSON.parse(body && body.length > 0 ? body : "{}") as unknown,
		catch: () =>
			new FailedToHandlePythLazerRequestError({
				error: "Request body must be valid JSON",
			}),
	});

const parseRequestedFeeds = (body: string | undefined) =>
	Effect.gen(function* () {
		const parsedBody = yield* parseJsonBody(body);
		const parsedRequest = tryParseSync(
			LatestPriceRequestBodySchema,
			parsedBody,
		);

		if (parsedRequest.isErr) {
			return yield* Effect.fail(
				new FailedToHandlePythLazerRequestError({
					error: parsedRequest.error.map((issue) => issue.message).join(", "),
				}),
			);
		}

		return getRequestedFeedIdentifiers(parsedRequest.value);
	});

// Legacy compatibility surface for POST /v1/latest_price. It returns the native
// Pyth Lazer { parsed: { timestampUs, priceFeeds } } shape from the live cache.
export const createLegacyLatestPriceHandler =
	({
		config,
		ensureSubscribedAndTrack,
		getOrWaitPrice,
		resolvePriceFeedIds,
	}: LegacyLatestPriceHandlerDeps) =>
	(body: string | undefined) =>
		Effect.gen(function* () {
			const requestedFeeds = yield* parseRequestedFeeds(body);

			if (requestedFeeds.length > config.maxFeedsPerRequest) {
				return yield* Effect.fail(
					new FailedToHandlePythLazerRequestError({
						error: `Too many price feeds, max is ${config.maxFeedsPerRequest} but got ${requestedFeeds.length}`,
					}),
				);
			}

			const priceFeedIds = yield* resolvePriceFeedIds(requestedFeeds);
			const now = yield* Clock.currentTimeMillis;
			yield* ensureSubscribedAndTrack(priceFeedIds, now);

			const cachedFeeds: CachedPriceFeed[] = [];
			for (const priceFeedId of priceFeedIds) {
				cachedFeeds.push(yield* getOrWaitPrice(priceFeedId));
			}

			return new Response(
				JSON.stringify({
					parsed: {
						timestampUs: maxTimestampUs(
							cachedFeeds.map((feed) => feed.timestampUs),
						),
						priceFeeds: cachedFeeds.map(toPythProPriceFeed),
					},
				}),
				{ status: 200 },
			);
		});
