import { tryParseSync } from "@seda-protocol/utils";
import { maybe } from "@seda-protocol/utils/valibot";
import type { HTTPMethod } from "elysia";
import { Result } from "true-myth";
import * as v from "valibot";
import { DEFAULT_HTTP_METHODS, DEFAULT_PROXY_ROUTE_GROUP } from "./constants";
import logger from "./logger";
import { replaceParams } from "./utils/replace-params";

const UNKNOWN_ATTRIBUTE_ERROR = "Unknown attribute";

const NotOptionsMethod = v.pipe(
	v.string(),
	v.notValue("OPTIONS", "OPTIONS method is reserved"),
);
const HttpMethodSchema = v.union([NotOptionsMethod, v.array(NotOptionsMethod)]);

const RouteSchema = v.strictObject(
	{
		baseURL: maybe(v.string()),
		path: v.string(),
		upstreamUrl: v.string(),
		method: v.optional(HttpMethodSchema, DEFAULT_HTTP_METHODS),
		jsonPath: v.optional(v.pipe(v.string(), v.startsWith("$"))),
		allowedQueryParams: v.optional(v.array(v.string())),
		forwardResponseHeaders: v.pipe(
			v.optional(v.array(v.string()), []),
			v.transform((methods) => {
				return new Set(methods.map((method) => method.toLowerCase()));
			}),
		),
		headers: v.optional(v.record(v.string(), v.string()), {}),
	},
	UNKNOWN_ATTRIBUTE_ERROR,
);

const ConfigSchema = v.strictObject(
	{
		routeGroup: v.optional(v.string(), DEFAULT_PROXY_ROUTE_GROUP),
		routes: v.array(RouteSchema),
		baseURL: maybe(v.string()),
		statusEndpoints: v.optional(
			v.strictObject(
				{
					root: v.string(),
					apiKey: v.optional(
						v.strictObject(
							{
								header: v.string(),
								secret: v.string(),
							},
							UNKNOWN_ATTRIBUTE_ERROR,
						),
					),
				},
				UNKNOWN_ATTRIBUTE_ERROR,
			),
			{
				root: "status",
			},
		),
	},
	UNKNOWN_ATTRIBUTE_ERROR,
);

export type Route = v.InferOutput<typeof RouteSchema>;
export type Config = v.InferOutput<typeof ConfigSchema>;

export function getHttpMethods(
	configuredMethod: Route["method"],
): HTTPMethod[] {
	if (!configuredMethod) return DEFAULT_HTTP_METHODS;
	if (Array.isArray(configuredMethod)) return configuredMethod;

	return [configuredMethod];
}

const pathRegex = new RegExp(/{(:[^}]+)}/g, "g");
// Match path with all the :varname in the path
const pathRegexElysia = new RegExp(/(:[^\/]+)/g);
const envVariablesRegex = new RegExp(/{(\$[^}]+)}/g, "g");

export function parseConfig(input: unknown): Result<Config, string> {
	const configResult = tryParseSync(ConfigSchema, input);
	if (configResult.isErr) {
		return Result.err(
			configResult.error
				.map((err) => {
					const key = err.path?.reduce((path, segment) => {
						return path.concat(".", segment.key as string);
					}, "");
					return `${key}: ${err.message}`;
				})
				.join("\n"),
		);
	}

	const config = configResult.value;

	if (config.statusEndpoints.root === config.routeGroup) {
		return Result.err(
			`"statusEndpoints.root" can not be the same as "routeGroup" (value: ${DEFAULT_PROXY_ROUTE_GROUP})`,
		);
	}

	if (config.statusEndpoints.apiKey) {
		const statusApiSecretEnvMatches =
			config.statusEndpoints.apiKey.secret.matchAll(envVariablesRegex);

		for (const match of statusApiSecretEnvMatches) {
			const envKey = match[1].replace("$", "");
			const envVariable = process.env[envKey];

			if (!envVariable) {
				return Result.err(
					`Status endpoint API key secret required ${envKey} but was not available in the environment`,
				);
			}

			config.statusEndpoints.apiKey.secret = replaceParams(
				config.statusEndpoints.apiKey.secret,
				{},
			);
		}
	}

	for (const [index, route] of config.routes.entries()) {
		const urlMatches = route.upstreamUrl.matchAll(pathRegex);

		// Content type should always be forwarded to the client
		route.forwardResponseHeaders.add("content-type");

		if (route.upstreamUrl.includes("{*}")) {
			if (!route.upstreamUrl.endsWith("{*}")) {
				return Result.err(
					`UpstreamUrl: ${route.upstreamUrl} uses {*} but was not at the end of the URL`,
				);
			}

			if (!route.path.endsWith("*")) {
				return Result.err(
					`UpstreamUrl: ${route.upstreamUrl} required {*} but path did not end with * (${route.path})`,
				);
			}
		}

		// Check if any variables on the url are not available in the route
		for (const match of urlMatches) {
			if (!route.path.includes(match[1])) {
				return Result.err(
					`url required ${match[1]} but was not given in route ${route.path}`,
				);
			}
		}

		// Also make sure we are not having any unused variables in the path
		for (const match of route.path.matchAll(pathRegexElysia)) {
			let isUsed = false;

			if (route.upstreamUrl.includes(match[1])) {
				isUsed = true;
			}

			// Make sure that its also not used in the headers
			for (const [_, headerValue] of Object.entries(route.headers)) {
				if (headerValue.includes(match[1])) {
					isUsed = true;
					break;
				}
			}

			if (!isUsed) {
				logger.warn(
					`$.${index}.path has set ${match[1]} but was not used in $.${index}.upstreamUrl or $.${index}.headers. \nPlease either remove the variable from the path or use it in the upstreamUrl or headers (through "{${match[1]}}").`,
				);
			}
		}

		// Check if the json path is using variables that is not in the route
		const jsonPathMatches = route.jsonPath?.matchAll(pathRegex) ?? [];

		// Check if any variables on the url are not available in the route
		for (const match of jsonPathMatches) {
			if (!route.path.includes(match[1])) {
				return Result.err(
					`jsonPath required ${match[1]} but was not given in route ${route.path}`,
				);
			}
		}

		for (const [headerKey, headerValue] of Object.entries(route.headers)) {
			const headerValuePathMatches = headerValue.matchAll(pathRegex);

			for (const match of headerValuePathMatches) {
				if (!route.path.includes(match[1])) {
					return Result.err(
						`Header ${headerKey} required ${match[1]} but was not given in route ${route.path}`,
					);
				}
			}

			const headerValueEnvMatches = headerValue.matchAll(envVariablesRegex);

			for (const match of headerValueEnvMatches) {
				const envKey = match[1].replace("$", "");
				const envVariable = process.env[envKey];

				if (!envVariable) {
					return Result.err(
						`Header ${headerKey} required ${envKey} but was not available in the environment`,
					);
				}

				route.headers[headerKey] = replaceParams(route.headers[headerKey], {});
			}
		}
	}

	return Result.ok(config);
}
