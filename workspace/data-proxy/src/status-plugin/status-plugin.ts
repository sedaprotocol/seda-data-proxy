import Elysia from "elysia";
import type { Config } from "../config-parser";
import type { Context } from "./types";

export function statusPlugin(
	context: Context,
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

			group.get("health", () => {
				return Response.json({
					status: "healthy",
					metrics: context.getMetrics(),
				});
			});

			group.get("pubkey", () => {
				return Response.json({
					pubKey: context.getPublicKey(),
				});
			});

			return group;
		});

		return app.use(plugin);
	};
}
