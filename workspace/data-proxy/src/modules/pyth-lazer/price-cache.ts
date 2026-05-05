import type { ParsedFeedPayload } from "@pythnetwork/pyth-lazer-sdk";
import { createPriceCache as createSharedPriceCache } from "../shared/price-cache";
import { FailedToGetPriceError } from "./errors";

export const createPriceCache = () =>
	createSharedPriceCache<number, ParsedFeedPayload, FailedToGetPriceError>({
		createError: (error) => new FailedToGetPriceError({ error }),
	});
