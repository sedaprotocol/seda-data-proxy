import { Effect, Either } from "effect";
import type { Route } from "../../config/config-parser";
import type { MultiModuleRoute } from "../../config/multi-module-config";
import type { ModuleHandlers } from "../../modules/module";
import { replaceParams } from "../../utils/replace-params";

// Fans a multi route out to its configured sub-fetches concurrently, forwarding
// each to its target module's own handler and collecting the raw responses
// keyed by fetch name. Sub-fetch failures are non-fatal: the failing entry
// carries an error and the rest still resolve. The combined object is returned
// as one response for the proxy to sign.
export const handleMultiRequest = (
	route: MultiModuleRoute,
	params: Record<string, string>,
	request: Request,
	moduleHandlers: ReadonlyMap<string, ModuleHandlers>,
) =>
	Effect.gen(function* () {
		const entries = yield* Effect.forEach(
			route.fetches,
			(fetch) =>
				Effect.gen(function* () {
					const handlers = moduleHandlers.get(fetch.moduleName);
					if (!handlers) {
						return [
							fetch.name,
							{ error: `Module ${fetch.moduleName} not found`, status: 500 },
						] as const;
					}

					const fetchFromModule = fetch.fetchFromModule
						? replaceParams(fetch.fetchFromModule, params)
						: "";
					const body = fetch.body
						? replaceParams(fetch.body, params)
						: undefined;

					const syntheticRoute = {
						type: fetch.type,
						moduleName: fetch.moduleName,
						fetchFromModule,
						path: route.path,
						method: route.method,
						allowedQueryParams: fetch.allowedQueryParams ?? [],
						headers: {},
						useLegacyJsonPath: true,
						forwardResponseHeaders: new Set<string>(),
					} as unknown as Route;

					const result = yield* Effect.either(
						handlers.handleRequest(syntheticRoute, params, request, body),
					);

					if (Either.isLeft(result)) {
						return [
							fetch.name,
							{ error: result.left.message, status: result.left.status },
						] as const;
					}

					const response = result.right;
					const text = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: (error) => new Error(`${error}`),
					}).pipe(Effect.catchAll(() => Effect.succeed("")));

					let parsed: unknown;
					try {
						parsed = text.length > 0 ? JSON.parse(text) : null;
					} catch {
						parsed = text;
					}

					if (!response.ok) {
						return [
							fetch.name,
							{
								error: "Sub-fetch returned a non-ok response",
								status: response.status,
								body: parsed,
							},
						] as const;
					}

					return [fetch.name, parsed] as const;
				}),
			{ concurrency: "unbounded" },
		);

		const combined: Record<string, unknown> = {};
		for (const [name, value] of entries) {
			combined[name] = value;
		}

		return new Response(JSON.stringify(combined), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
