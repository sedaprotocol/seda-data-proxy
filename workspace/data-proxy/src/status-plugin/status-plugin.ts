import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Duration, Match, Option, Runtime } from "effect";
import { Effect } from "effect";
import Elysia from "elysia";
import { Result } from "true-myth";
import type { Config } from "../config-parser";
import logger from "../logger";
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

		return (app: Elysia) =>
			Runtime.runSync(
				runtime,
				Effect.gen(function* () {
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

						group.get("health", async ({ set }) => {
							let healthy = true;

							if (config.fastOnly) {
								healthy = true;
								set.status = 200;
							} else {
								const chainId = await effectToAsyncResult(runtime, getRpcChainId(dataProxy.options.rpcUrl));
								const hasCorrectChainId =
									chainId.isOk && chainId.value === dataProxy.options.chainId;

								set.status = chainId.isOk && hasCorrectChainId ? 200 : 500;
								healthy = chainId.isOk && hasCorrectChainId;
							}

							return Response.json({
								status: healthy ? "healthy" : "unhealthy",
								metrics: context.getMetrics(),
							});
						});

						group.get("info", async () => {
							const chainId = config.fastOnly
								? Result.ok(dataProxy.options.chainId)
								: await effectToAsyncResult(runtime, getRpcChainId(dataProxy.options.rpcUrl));

							return Response.json({
								pubKey: context.getPublicKey(),
								fastConfig: context.getFastConfig(),
								version: getVersions().proxy,
								chainId: dataProxy.options.chainId,
								rpcChainId: chainId.isOk ? chainId.value : null,
							});
						});

						return group;
					});

					logger.info(
						`Status endpoints: /${options.root}/health, /${options.root}/info`,
					);
					return app.use(plugin);
				}),
			);
	});
