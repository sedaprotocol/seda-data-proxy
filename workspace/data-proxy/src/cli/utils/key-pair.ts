import * as v from "valibot";

export const FileKeyPairSchema = v.object({
	pubkey: v.optional(v.string()),
	privkey: v.string(),
});

export type FileKeyPair = v.InferOutput<typeof FileKeyPairSchema>;
