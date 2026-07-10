import * as v from "valibot";
import { HAS_PRICE_KEY } from "../../constants";

export type VolmexResponse =
	| (VolmexDataPrice & {
			[HAS_PRICE_KEY]: true;
	  })
	| {
			symbol: string;
			[HAS_PRICE_KEY]: false;
	  };

export const VolmexDataPriceSchema = v.object({
	symbol: v.string(),
	price: v.number(),
	timestamp: v.number(),
});

export type VolmexDataPrice = v.InferOutput<typeof VolmexDataPriceSchema>;
