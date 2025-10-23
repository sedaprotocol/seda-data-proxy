import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import Elysia from "elysia";
import type { Config } from "../config-parser";
import { getRpcChainId } from "../services/get-rpc-chain-id";
import { effectToAsyncResult } from "../utils/effect-utils";
import { getVersions } from "../utils/versions";
import type { Context } from "./types";

export function statusPlugin(
	context: Context,
	dataProxy: DataProxy,
	options: Config["statusEndpoints"],
) {
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

			group.get("health", async ({ set }) => {
				const chainId = await effectToAsyncResult(
					getRpcChainId(dataProxy.options.rpcUrl),
				);
				const hasCorrectChainId =
					chainId.isOk && chainId.value === dataProxy.options.chainId;

				set.status = chainId.isOk && hasCorrectChainId ? 200 : 500;

				return Response.json({
					status: chainId.isOk && hasCorrectChainId ? "healthy" : "unhealthy",
					metrics: context.getMetrics(),
					version: getVersions().proxy,
					chainId: dataProxy.options.chainId,
					rpcChainId: chainId.isOk ? chainId.value : null,
				});
			});

			group.get("info", () => {
				return Response.json({
					pubKey: context.getPublicKey(),
					fastConfig: context.getFastConfig(),
					version: getVersions().proxy,
				});
			});

			return group;
		});

		return app.use(plugin);
	};
}
