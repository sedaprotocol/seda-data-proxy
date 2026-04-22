import { randomUUID } from "node:crypto";
import { openapi } from "@elysiajs/openapi";
import { constants, type DataProxy } from "@seda-protocol/data-proxy-sdk";
import {
	Duration,
	Effect,
	HashMap,
	Layer,
	Match,
	MutableHashMap,
	Option,
	Runtime,
	Schedule,
} from "effect";
import { Elysia } from "elysia";
import { type Config, getHttpMethods } from "./config/config-parser";
import { DEFAULT_PROXY_ROUTE_GROUP } from "./constants";
import { handleProxyRequest } from "./controllers/proxy/handle-proxy-request";
import { ChainlinkStreamsModuleService } from "./modules/chainlink-streams/chainlink-streams";
import { EmptyModuleService, ModuleService } from "./modules/module";
import { PythLazerModuleService } from "./modules/pyth-lazer/pyth-lazer";
import type { HttpClientService } from "./services/http-client";
import { StatusContext, statusPlugin } from "./status-plugin";

export interface ProxyServerOptions {
	port: number;
	disableProof: boolean;
	/**
	 * If false, the keep alive fiber will not be started.
	 * This is because of a bug where the scope gets cleaned up while executing.
	 * We need this option because in tests we want to not have an infinite loop of keep alive fibers.
	 */
	enableKeepAliveFiber: boolean;
}

export const startProxyServer = (
	config: Config,
	dataProxy: DataProxy,
	serverOptions: ProxyServerOptions,
) =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<HttpClientService>();
		const modules = MutableHashMap.empty<
			string,
			Layer.Layer<ModuleService, unknown, never>
		>();

		// Initialize the modules and start them
		for (const moduleConfig of config.modules) {
			const moduleLayer = yield* Match.value(moduleConfig).pipe(
				Match.when({ type: "pyth-lazer" }, (m) =>
					Layer.memoize(PythLazerModuleService(m)),
				),
				Match.when({ type: "chainlink-streams" }, (m) =>
					Layer.memoize(ChainlinkStreamsModuleService(m)),
				),
				Match.exhaustive,
			);

			yield* Effect.gen(function* () {
				const moduleService = yield* ModuleService;
				yield* moduleService.start();
			}).pipe(Effect.provide(moduleLayer));

			MutableHashMap.set(modules, moduleConfig.name, moduleLayer);
		}

		// Make sure that all routes are correctly configured with their respective module
		for (const route of config.routes) {
			if (route.type === "pyth-lazer" || route.type === "chainlink-streams") {
				const moduleLayer = MutableHashMap.get(modules, route.moduleName);
				if (Option.isNone(moduleLayer)) {
					return yield* Effect.die(`Module ${route.moduleName} not found`);
				}
			}
		}

		const server = new Elysia()
			.use(
				openapi({
					path: "/docs",
				}),
			)
			// Assign a unique ID to every request
			.derive(() => {
				return {
					requestId: randomUUID(),
				};
			})
			.onBeforeHandle(
				({
					requestId,
					headers,
					body,
					params,
					path,
					query,
					request: { method },
				}) => {
					Runtime.runSync(
						runtime,
						Effect.logDebug(`Received request ${method} ${path}`, {
							requestId,
							headers,
							body,
							params,
							path,
							query,
							method,
						}),
					);
				},
			)
			.onAfterResponse(({ requestId, responseValue }) => {
				Runtime.runSync(
					runtime,
					Effect.logDebug("Responded to request", {
						requestId,
						response: responseValue,
					}),
				);
			});

		const statusContext = new StatusContext(
			dataProxy.publicKey.toString("hex"),
			config.sedaFast,
		);
		server.use(
			yield* statusPlugin(
				statusContext,
				dataProxy,
				config.statusEndpoints,
				config,
			),
		);
		const proxyGroup = config.routeGroup ?? DEFAULT_PROXY_ROUTE_GROUP;

		server.group(proxyGroup, (app) => {
			// Only update the status context in routes that are part of the proxy group
			app.onBeforeHandle(() => statusContext.incrementRequests());
			app.onAfterHandle(({ response }) => {
				if (response instanceof Response && !response.ok) {
					statusContext.incrementErrors();
				}
			});

			for (const route of config.routes) {
				app.route("OPTIONS", route.path, () => {
					const headers = new Headers({
						[constants.PUBLIC_KEY_HEADER_KEY]:
							dataProxy.publicKey.toString("hex"),
						[constants.SIGNATURE_VERSION_HEADER_KEY]: dataProxy.version,
					});
					return new Response(null, { headers });
				});

				// A route can have multiple methods attach to it
				const routeMethods = getHttpMethods(route.method);
				for (const routeMethod of routeMethods) {
					app.route(
						routeMethod,
						route.path,
						async ({ headers, params, body, path, requestId, request }) =>
							Runtime.runPromise(
								runtime,
								Effect.gen(function* () {
									// requestBody is now always a string because of the parse function in this route
									const requestBody = Option.fromNullable(
										body as string | undefined,
									);

									const moduleLayer = MutableHashMap.get(
										modules,
										route.moduleName,
									).pipe(Option.getOrElse(() => EmptyModuleService));

									return yield* handleProxyRequest({
										serverOptions,
										headers,
										params,
										body: requestBody,
										path,
										request,
										route,
										config,
										dataProxy,
									}).pipe(Effect.provide(moduleLayer));
								}).pipe(
									Effect.annotateLogs("requestId", requestId),
									Effect.annotateLogs("method", request.method),
									Effect.annotateLogs("path", path),
								),
							),
						{
							config: {},
							parse: ({ request }) => {
								// TODO: forward the request body transparently.
								// https://github.com/sedaprotocol/seda-data-proxy/issues/12
								return request.text();
							},
						},
					);
				}
			}

			return app;
		});

		server.listen(serverOptions.port);
		yield* Effect.logInfo(
			`Proxy routes is at http://127.0.0.1:${serverOptions.port}/${proxyGroup === "" || proxyGroup.endsWith("/") ? `${proxyGroup}` : `${proxyGroup}/`}`,
		);

		yield* Effect.logInfo(
			`Docs are at http://127.0.0.1:${serverOptions.port}/docs`,
		);

		// NOTE: For some reason the program gets half out of scope and the logger stops working
		// This is a workaround to keep the main fiber alive
		if (serverOptions.enableKeepAliveFiber) {
			yield* Effect.void.pipe(
				Effect.schedule(Schedule.spaced(Duration.seconds(10))),
			);
		}

		return server;
	});
