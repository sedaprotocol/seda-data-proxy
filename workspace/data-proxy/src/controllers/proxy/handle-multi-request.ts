import { Effect, Either } from "effect";
import type { Route } from "../../config/config-parser";
import type { MultiModuleRoute } from "../../config/multi-module-config";
import { PYTH_LAZER_DEFAULT_CHANNEL } from "../../config/pyth-lazer-module-config";
import type { ModuleHandlers } from "../../modules/module";
import { replaceParams } from "../../utils/replace-params";

// Fans a multi route out to its configured sub-fetches concurrently, forwarding
// each to its target module's own handler and collecting the raw responses
// keyed by fetch name. Sub-fetch failures are non-fatal: the failing entry
// carries an error and the rest still resolve. The combined object is returned
// as one response for the proxy to sign.
//
// A `sources` query param (comma-separated fetch names) restricts the fan-out
// to the named sub-fetches, so a caller that only wants some venues does not
// pay for the rest (an unlisted symbol otherwise blocks on the price-wait
// timeout). The param is part of the signed request URL, so selection needs no
// signing changes. Without the param every configured fetch runs.
export const handleMultiRequest = (
	route: MultiModuleRoute,
	params: Record<string, string>,
	request: Request,
	moduleHandlers: ReadonlyMap<string, ModuleHandlers>,
) =>
	Effect.gen(function* () {
		const sourcesParam = new URL(request.url).searchParams.get("sources");
		let selectedFetches = route.fetches;

		if (sourcesParam !== null) {
			const requested = sourcesParam
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0);

			const knownNames = route.fetches.map((fetch) => fetch.name);
			const unknown = requested.filter((name) => !knownNames.includes(name));

			// A typo in the selection should fail loudly here instead of
			// surfacing downstream as a confusing "not enough sources" error.
			if (requested.length === 0 || unknown.length > 0) {
				const detail =
					unknown.length > 0
						? `unknown source(s): ${unknown.join(", ")}`
						: "no sources selected";
				return new Response(
					JSON.stringify({
						error: `Invalid 'sources' query param: ${detail}. Configured sources: ${knownNames.join(", ")}`,
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}

			selectedFetches = route.fetches.filter((fetch) =>
				requested.includes(fetch.name),
			);
		}

		const entries = yield* Effect.forEach(
			selectedFetches,
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
						...(fetch.type === "pyth-lazer"
							? {
									channel: fetch.channel ?? PYTH_LAZER_DEFAULT_CHANNEL,
								}
							: {}),
					} as Route;

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
