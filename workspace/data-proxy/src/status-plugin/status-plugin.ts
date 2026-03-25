import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Effect, Either, Runtime } from "effect";
import Elysia from "elysia";
import type { Config } from "../config/config-parser";
import { getRpcChainId } from "../services/get-rpc-chain-id";
import { effectToAsyncResult } from "../utils/effect-utils";
import { getVersions } from "../utils/versions";
import type { Context } from "./types";

export const statusPlugin = (
	context: Context,
	dataProxy: DataProxy,
	options: Config["statusEndpoints"],
	config: Config,
) =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime();

		return (app: Elysia) => {
			const plugin = new Elysia({
				name: "status",
			});

			plugin.group(options.root, (group) => {
				if (options.apiKey) {
					const { header, secret } = options.apiKey;
					group.onBeforeHandle(({ request }) => {
						const apiKey = request.headers.get(header);
						if (apiKey !== secret) {
							return new Response("Unauthorized", { status: 401 });
						}
					});
				}

				// List all available endpoints
				group.get("", () => {
					return Response.json({
						endpoints: [`${options.root}/health`, `${options.root}/info`],
					});
				});

				group.get("health", async ({ set }) =>
					Runtime.runPromise(
						runtime,
						Effect.gen(function* () {
							let healthy = true;

							if (config.fastOnly) {
								healthy = true;
							} else {
								const chainId = yield* Effect.either(
									getRpcChainId(dataProxy.options.rpcUrl),
								);
								const hasCorrectChainId =
									Either.isRight(chainId) &&
									chainId.right === dataProxy.options.chainId;

								healthy = hasCorrectChainId;
							}

							set.status = healthy ? 200 : 500;

							return Response.json({
								status: healthy ? "healthy" : "unhealthy",
								metrics: context.getMetrics(),
							});
						}),
					),
				);

				group.get("info", async () =>
					Runtime.runPromise(
						runtime,
						Effect.gen(function* () {
							const chainId = yield* Effect.either(
								getRpcChainId(dataProxy.options.rpcUrl),
							);

							return Response.json({
								pubKey: context.getPublicKey(),
								fastConfig: context.getFastConfig(),
								version: getVersions().proxy,
								chainId: dataProxy.options.chainId,
								rpcChainId: Either.isRight(chainId) ? chainId.right : null,
							});
						}),
					),
				);

				return group;
			});

			Runtime.runSync(
				runtime,
				Effect.logInfo(
					`Status endpoints: /${options.root}/health, /${options.root}/info`,
				),
			);

			return app.use(plugin);
		};
	});
