import type { ProtobufRpcClient } from "@cosmjs/stargate";
import { sedachain } from "@seda-protocol/proto-messages";
import { Effect } from "effect";
import { FailedToGetCoreContractAddressError } from "./errors";

export const getLatestCoreContractAddress = (protoRpcClient: ProtobufRpcClient) =>
	Effect.gen(function* () {
		const sedaQueryClient = new sedachain.wasm_storage.v1.QueryClientImpl(protoRpcClient);
		const response = yield* Effect.tryPromise({
			try: () => sedaQueryClient.CoreContractRegistry({}),
			catch: (error) => new FailedToGetCoreContractAddressError({ error }),
		});

		return response.address;
	});
