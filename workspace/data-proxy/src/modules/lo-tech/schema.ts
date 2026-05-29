import * as v from "valibot";
import {
	LO_TECH_DATA_TYPE_PRICE,
	type LoTechDataType,
} from "../../config/lo-tech-module-config";
import { HAS_PRICE_KEY } from "../../constants";

export type LoTechResponse =
	| (LoTechDataPrice & {
			[HAS_PRICE_KEY]: true;
	  })
	| {
			symbol: string;
			[HAS_PRICE_KEY]: false;
	  };

/*
 * Data messages
 */
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

/*
 * Ack messages
 */
export const LoTechAckSchema = v.strictObject({
	egress_ts: v.number(),
	ack: v.object({
		id: v.number(),
	}),
});

export type LoTechAck = v.InferOutput<typeof LoTechAckSchema>;

/*
 * Error messages
 */
export const LoTechSubscriptionFailureCode = 14;
export const LoTechSubscriptionFailureSchema = v.object({
	error: v.string(),
	code: v.literal(LoTechSubscriptionFailureCode),
	id: v.number(),
	info: v.object({
		type: v.literal("subscription_failure"),
		failures: v.array(
			v.object({
				type: v.literal("topic_parse_error"),
				raw: v.object({
					symbol: v.string(),
					type: v.literal(LO_TECH_DATA_TYPE_PRICE),
				}),
				message: v.string(),
			}),
		),
		succeeded: v.array(
			v.object({
				symbol: v.string(),
				type: v.literal(LO_TECH_DATA_TYPE_PRICE),
			}),
		),
	}),
});

export const LoTechParsedErrorSchema = v.variant("code", [
	LoTechSubscriptionFailureSchema,
]);

export const LoTechErrorMessageSchema = v.object({
	egress_ts: v.number(),
	error: LoTechParsedErrorSchema,
});

export type LoTechErrorMessage = v.InferOutput<typeof LoTechErrorMessageSchema>;

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
