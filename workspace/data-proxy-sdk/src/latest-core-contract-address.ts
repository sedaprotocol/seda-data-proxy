import type { ProtobufRpcClient } from "@cosmjs/stargate";
import { sedachain } from "@seda-protocol/proto-messages";
import { tryAsync } from "@seda-protocol/utils";
import type { Result } from "true-myth";

export async function getLatestCoreContractAddress(
	protoRpcClient: ProtobufRpcClient,
): Promise<Result<string, Error>> {
	const sedaQueryClient = new sedachain.wasm_storage.v1.QueryClientImpl(
		protoRpcClient,
	);
	const response = await tryAsync(sedaQueryClient.CoreContractRegistry({}));

	return response.map((v) => v.address);
}
