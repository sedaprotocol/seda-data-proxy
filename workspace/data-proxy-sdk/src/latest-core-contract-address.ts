import { QueryClient, createProtobufRpcClient } from "@cosmjs/stargate";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import { sedachain } from "@seda-protocol/proto-messages";
import { tryAsync } from "@seda-protocol/utils";
import { Result } from "true-myth";

export async function getLatestCoreContractAddress(
	rpc: string,
): Promise<Result<string, unknown>> {
	const cometClient = await tryAsync(async () => Comet38Client.connect(rpc));

	if (cometClient.isErr) {
		return Result.err(cometClient.error);
	}

	const queryClient = new QueryClient(cometClient.value);
	const protoRpcClient = createProtobufRpcClient(queryClient);

	const sedaQueryClient = new sedachain.wasm_storage.v1.QueryClientImpl(
		protoRpcClient,
	);
	const response = await tryAsync(async () =>
		sedaQueryClient.CoreContractRegistry({}),
	);

	return response.map((v) => v.address);
}
