import type { ProtobufRpcClient } from "@cosmjs/stargate";
import { sedachain } from "@seda-protocol/proto-messages";
import { tryAsync } from "@seda-protocol/utils";
import { Result } from "true-myth";

export async function getDataProxyRegistration(
	protoRpcClient: ProtobufRpcClient,
	publicKeyHex: string,
): Promise<Result<sedachain.data_proxy.v1.ProxyConfig, Error>> {
	const sedaQueryClient = new sedachain.data_proxy.v1.QueryClientImpl(
		protoRpcClient,
	);
	const response = await tryAsync(
		sedaQueryClient.DataProxyConfig({
			pubKey: publicKeyHex,
		}),
	);

	if (response.isErr) {
		if (response.error.message.includes("not found")) {
			return Result.err(
				new Error(`No registration found for "${publicKeyHex}"`),
			);
		}

		return Result.err(response.error);
	}

	if (response.value.config) {
		return Result.ok(response.value.config);
	}

	return Result.err(new Error(`No registration found for "${publicKeyHex}"`));
}
