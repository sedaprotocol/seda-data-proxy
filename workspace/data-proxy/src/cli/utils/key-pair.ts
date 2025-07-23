import { Environment } from "@seda-protocol/data-proxy-sdk";
import * as v from "valibot";

export const FileKeyPairSchema = v.object({
	network: v.optional(
		v.picklist(Object.values(Environment)),
		Environment.Testnet,
	),
	pubkey: v.optional(v.string()),
	privkey: v.string(),
});

export type FileKeyPair = v.InferOutput<typeof FileKeyPairSchema>;
