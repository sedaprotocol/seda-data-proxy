import type { LoTechDataType } from "../../config/lo-tech-module-config";

export type LoTechDataPrice = {
	type: Extract<LoTechDataType, "PRICE">;
	symbol: string;
	ingress_ts: number;
	publish_ts: number | null;
	transaction_ts: number;
	price: number;
	spread: number;
};

export type LoTechData = LoTechDataPrice;

export type LoTechDataMessage = {
	egress_ts: number;
	data: LoTechData;
};

export type LoTechAckMessage = {
	egress_ts: number;
	ack: {
		id: number;
	};
};

export type LoTechMessage = LoTechDataMessage | LoTechAckMessage;
