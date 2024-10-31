import {
	type ProtobufRpcClient,
	QueryClient,
	createProtobufRpcClient,
} from "@cosmjs/stargate";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import { tryAsync } from "@seda-protocol/utils";
import { Result } from "true-myth";

export async function getProtobufRpcClient(
	rpc: string,
): Promise<Result<ProtobufRpcClient, unknown>> {
	const cometClient = await tryAsync(Comet38Client.connect(rpc));

	if (cometClient.isErr) {
		return Result.err(cometClient.error);
	}

	const queryClient = new QueryClient(cometClient.value);
	const protoRpcClient = createProtobufRpcClient(queryClient);

	return Result.ok(protoRpcClient);
}
