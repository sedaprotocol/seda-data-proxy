import { maybe } from "@seda-protocol/utils/valibot";
import * as v from "valibot";
import { DEFAULT_HTTP_METHODS } from "../constants";

const UNKNOWN_ATTRIBUTE_ERROR = "Unknown attribute";

const NotOptionsMethod = v.pipe(
	v.string(),
	v.notValue("OPTIONS", "OPTIONS method is reserved"),
);

const HttpMethodSchema = v.union([NotOptionsMethod, v.array(NotOptionsMethod)]);

// Base route schema for all routes
export const RouteSchema = v.strictObject(
	{
		baseURL: maybe(v.string()),
		path: v.string(),
		method: v.optional(HttpMethodSchema, DEFAULT_HTTP_METHODS),
		jsonPath: v.optional(v.pipe(v.string(), v.startsWith("$"))),
		allowedQueryParams: v.optional(v.array(v.string())),
		headers: v.optional(v.record(v.string(), v.string()), {}),
		useLegacyJsonPath: v.optional(v.boolean(), true),
		forwardResponseHeaders: v.pipe(
			v.optional(v.array(v.string()), []),
			v.transform((methods) => {
				return new Set(methods.map((method) => method.toLowerCase()));
			}),
		),
	},
	UNKNOWN_ATTRIBUTE_ERROR,
);
