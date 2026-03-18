import type { ProtobufRpcClient } from "@cosmjs/stargate";
import { sedachain } from "@seda-protocol/proto-messages";
import { Effect } from "effect";
import { FailedToGetDataProxyRegistrationError } from "./errors";

export const getDataProxyRegistration = (protoRpcClient: ProtobufRpcClient, publicKeyHex: string) =>
	Effect.gen(function* () {
		const sedaQueryClient = new sedachain.data_proxy.v1.QueryClientImpl(protoRpcClient);
		const response = yield* Effect.tryPromise({
			try: () =>
				sedaQueryClient.DataProxyConfig({
					pubKey: publicKeyHex,
				}),
			catch: (error) => {
				const errorAsString = `${error}`;

				if (errorAsString.includes("not found")) {
					return new FailedToGetDataProxyRegistrationError({
						error: `No registration found for "${publicKeyHex}"`,
					});
				}

				return new FailedToGetDataProxyRegistrationError({
					error: errorAsString,
				});
			},
		});

		if (!response.config) {
			return yield* Effect.fail(
				new FailedToGetDataProxyRegistrationError({
					error: `No registration found for "${publicKeyHex}"`,
				}),
			);
		}

		return response.config;
	});
