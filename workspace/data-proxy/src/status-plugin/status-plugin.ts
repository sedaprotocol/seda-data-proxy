import { node } from "@elysiajs/node";
import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Effect, Either, Runtime } from "effect";
import Elysia from "elysia";
import type { Config } from "../config/config-parser";
import { getRpcChainId } from "../services/get-rpc-chain-id";
import type { SocketHealthRegistry } from "../services/socket-health";
import { getVersions } from "../utils/versions";
import type { Context } from "./types";

export const statusPlugin = (
	context: Context,
	dataProxy: DataProxy,
	options: Config["statusEndpoints"],
	config: Config,
	socketHealth: SocketHealthRegistry,
) =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime();

		return (app: Elysia) => {
			const plugin = new Elysia({
				adapter: node(),
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
							const now = Date.now();
							const stale = socketHealth.staleSockets(now);
							for (const socket of socketHealth.newlyStale(now)) {
								yield* Effect.logWarning(
									"Websocket disconnected past health grace",
									socket,
								);
							}

							let healthy = stale.length === 0;

							if (!config.fastOnly) {
								const chainId = yield* Effect.either(
									getRpcChainId(dataProxy.options.rpcUrl),
								);
								const hasCorrectChainId =
									Either.isRight(chainId) &&
									chainId.right === dataProxy.options.chainId;

								healthy = healthy && hasCorrectChainId;
							}

							const status = healthy ? 200 : 500;
							set.status = status;

							return Response.json(
								{
									status: healthy ? "healthy" : "unhealthy",
									metrics: context.getMetrics(),
									...(stale.length > 0 ? { sockets: stale } : {}),
								},
								{ status },
							);
						}),
					),
				);

				group.get("info", async () =>
					Runtime.runPromise(
						runtime,
						Effect.gen(function* () {
							// fastOnly can run with no network, so there is no RPC URL to query.
							const chainId = dataProxy.options.rpcUrl
								? yield* Effect.either(getRpcChainId(dataProxy.options.rpcUrl))
								: Either.left("RPC URL is not configured");

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
