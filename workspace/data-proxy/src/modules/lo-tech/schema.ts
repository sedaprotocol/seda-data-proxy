import * as v from "valibot";
import {
	LO_TECH_DATA_TYPE_PRICE,
	type LoTechDataType,
} from "../../config/lo-tech-module-config";

export const LoTechDataPriceSchema = v.strictObject({
	type: v.literal(LO_TECH_DATA_TYPE_PRICE),
	symbol: v.string(),
	ingress_ts: v.number(),
	publish_ts: v.nullable(v.number()),
	transaction_ts: v.number(),
	price: v.number(),
	spread: v.number(),
});

export type LoTechDataPrice = v.InferOutput<typeof LoTechDataPriceSchema>;

export const LoTechParsedDataSchema = v.variant("type", [
	LoTechDataPriceSchema,
]);

export type LoTechParsedData = v.InferOutput<typeof LoTechParsedDataSchema>;

export type LoTechData = LoTechParsedData;

export const LoTechDataMessageSchema = v.object({
	egress_ts: v.number(),
	data: LoTechParsedDataSchema,
});

export type LoTechDataMessage = v.InferOutput<typeof LoTechDataMessageSchema>;

export type LoTechAckMessage = {
	egress_ts: number;
	ack: {
		id: number;
	};
};

export type LoTechMessage = LoTechDataMessage | LoTechAckMessage;

/**
 * Compile-time: keep LoTechDataType (config picklist) and parsed `type`
 * discriminants in sync — together they imply the same string union.
 *
 * - Config ⊆ parsed: every picklist entry has a `v.variant` branch.
 * - Parsed ⊆ config: every emitted `type` is allowed by the picklist.
 */
const _loTechParsedDataExhaustsLoTechDataType: Exclude<
	LoTechDataType,
	LoTechParsedData["type"]
> extends never
	? true
	: never = true;

const _loTechParsedVariantsSubsetOfLoTechDataType: Exclude<
	LoTechParsedData["type"],
	LoTechDataType
> extends never
	? true
	: never = true;
