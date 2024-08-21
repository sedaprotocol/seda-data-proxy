import { Environment } from "@seda-protocol/data-proxy-sdk";
import type { HTTPMethod } from "elysia";

// Environment constants
export const SERVER_PORT = process.env.SERVER_PORT ?? "5384";
export const LOG_LEVEL = process.env.LOG_LEVEL ?? "debug";
export const DEFAULT_ENVIRONMENT: Environment =
	(process.env.SEDA_ENV as Environment) ?? Environment.Devnet;

// App constants
export const PROOF_HEADER_KEY = "x-seda-proof";
export const SIGNATURE_HEADER_KEY = "x-seda-signature";
export const PUBLIC_KEY_HEADER_KEY = "x-seda-publickey";
export const JSON_PATH_HEADER_KEY = "x-seda-json-path";

export const PRIVATE_KEY_ENV_KEY = "SEDA_DATA_PROXY_PRIVATE_KEY";
export const PRIVATE_KEY = process.env[PRIVATE_KEY_ENV_KEY];
export const DEFAULT_PRIVATE_KEY_JSON_FILE_NAME =
	"./data-proxy-private-key.json";

// Where all the proxy routes go to (For example /proxy/CONFIGURED_ROUTE_HERE)
export const DEFAULT_PROXY_ROUTE_GROUP = "proxy";
// Default http methods set when no method is provided in the config
export const DEFAULT_HTTP_METHODS: HTTPMethod[] = [
	"GET",
	"PATCH",
	"POST",
	"PUT",
	"DELETE",
	"OPTIONS",
	"HEAD",
];
