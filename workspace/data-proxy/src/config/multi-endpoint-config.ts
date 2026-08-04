import * as v from "valibot";

export const DEFAULT_MULTI_ENDPOINT_PATH = "multi";
export const DEFAULT_MULTI_MAX_REQUESTS = 20;
export const DEFAULT_MULTI_CONCURRENCY = 5;

export const MultiEndpointSchema = v.strictObject({
	enable: v.optional(v.boolean(), false),
	path: v.optional(v.string(), DEFAULT_MULTI_ENDPOINT_PATH),
	maxRequests: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1, "maxRequests must be a positive integer"),
		),
		DEFAULT_MULTI_MAX_REQUESTS,
	),
	concurrency: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1, "concurrency must be a positive integer"),
		),
		DEFAULT_MULTI_CONCURRENCY,
	),
});

export type MultiEndpoint = v.InferOutput<typeof MultiEndpointSchema>;

// A single request inside a multi endpoint body. `path` is matched against the
// proxy's configured routes (same public paths clients already call one-by-one).
export const MultiEndpointRequestSchema = v.strictObject({
	path: v.pipe(v.string(), v.minLength(1, "path must not be empty")),
	method: v.optional(v.string(), "GET"),
	query: v.optional(
		v.record(v.string(), v.union([v.string(), v.array(v.string())])),
	),
	// Optional headers for the request.
	headers: v.optional(v.record(v.string(), v.string()), {}),
	// String is forwarded as-is; objects/arrays are JSON-stringified.
	body: v.optional(v.unknown()),
});

export type MultiEndpointRequest = v.InferOutput<
	typeof MultiEndpointRequestSchema
>;

export const MultiEndpointRequestBodySchema = v.pipe(
	v.record(
		v.pipe(v.string(), v.minLength(1, "id must not be empty")),
		MultiEndpointRequestSchema,
	),
	v.check(
		(entries) => Object.keys(entries).length >= 1,
		"request body must contain at least one entry",
	),
);

export type MultiEndpointRequestBody = v.InferOutput<
	typeof MultiEndpointRequestBodySchema
>;
