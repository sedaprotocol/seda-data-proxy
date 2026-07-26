import { Effect, Either } from "effect";
import type { Route } from "../../config/config-parser";
import {
	EMPTY_PARAM_TOKEN,
	EMPTY_RESPONSE_BY_TYPE,
	type MultiFetch,
	type MultiModuleRoute,
} from "../../config/multi-module-config";
import { PYTH_LAZER_DEFAULT_CHANNEL } from "../../config/pyth-lazer-module-config";
import type { ModuleHandlers } from "../../modules/module";
import { replaceParams } from "../../utils/replace-params";

// Stripping at param level covers fetchFromModule and body alike, without
// having to parse either format.
export const sanitizeParams = (
	params: Record<string, string>,
): Record<string, string> => {
	const sanitized: Record<string, string> = {};

	for (const [key, value] of Object.entries(params)) {
		sanitized[key] = value
			.split(",")
			.map((element) => element.trim())
			.filter((element) => element !== EMPTY_PARAM_TOKEN)
			.join(",");
	}

	return sanitized;
};

// Scans the raw templates: after substitution an intentionally-emptied param
// is indistinguishable from one that was never referenced.
export const emptyParamsFor = (
	fetch: MultiFetch,
	sanitized: Record<string, string>,
): string[] => {
	const templates = [fetch.fetchFromModule ?? "", fetch.body ?? ""];
	const empty: string[] = [];

	for (const [key, value] of Object.entries(sanitized)) {
		if (value.length > 0) {
			continue;
		}

		// Mirrors replaceParams, which substitutes both forms for the wildcard.
		const references = key === "*" ? ["{*}", "{:*}"] : [`{:${key}}`];

		if (
			templates.some((template) =>
				references.some((reference) => template.includes(reference)),
			)
		) {
			empty.push(key);
		}
	}

	return empty;
};

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
//
// A `_` path element means "no asset for this source": it is stripped before
// templates are filled, and a fetch whose param it empties is skipped.
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

		const sanitizedParams = sanitizeParams(params);

		const entries = yield* Effect.forEach(
			selectedFetches,
			(fetch) =>
				Effect.gen(function* () {
					// The price modules would otherwise block on the full
					// price-wait timeout for a symbol nobody asked for.
					if (emptyParamsFor(fetch, sanitizedParams).length > 0) {
						return [fetch.name, EMPTY_RESPONSE_BY_TYPE[fetch.type]] as const;
					}

					const handlers = moduleHandlers.get(fetch.moduleName);
					if (!handlers) {
						return [
							fetch.name,
							{ error: `Module ${fetch.moduleName} not found`, status: 500 },
						] as const;
					}

					const fetchFromModule = fetch.fetchFromModule
						? replaceParams(fetch.fetchFromModule, sanitizedParams)
						: "";
					const body = fetch.body
						? replaceParams(fetch.body, sanitizedParams)
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
						handlers.handleRequest(
							syntheticRoute,
							sanitizedParams,
							request,
							body,
						),
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
