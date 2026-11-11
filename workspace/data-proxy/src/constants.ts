import { Environment } from "@seda-protocol/data-proxy-sdk";
import { Config } from "effect";
import type { Literal } from "effect/LogLevel";
import type { HTTPMethod } from "elysia";
import { firstLetterToUpperCase } from "./utils/string-utils";

// Server constants
export const SERVER_PORT = process.env.SERVER_PORT ?? "5384";

// Environment constants
export const DEFAULT_ENVIRONMENT: Environment =
	(process.env.SEDA_ENV as Environment) ?? Environment.Testnet;

// App constants
export const JSON_PATH_HEADER_KEY = "x-seda-json-path";

// Verification constants
export const DEFAULT_VERIFICATION_MAX_RETRIES = 2;
export const DEFAULT_VERIFICATION_RETRY_DELAY = 1000;

// Official SEDA FAST client keys.
export const DEFAULT_FAST_ALLOWED_CLIENTS = [
	// mainnet
	"02c7cc8570d26bb3cf066ed5e14cf049e531248554aa4ee9ef619c2070d8e127bb",
	// mainnet
	"0220c300a6700844c84297ff9168e130c008da83d2db6f5b78ab44bd8724c3c82b",
	// testnet
	"021eacf821d4d21ad61515fc1212ca75739730bf0abcf4925045e3ebde0f93a7e8",
];

export const PRIVATE_KEY_ENV_KEY = "SEDA_DATA_PROXY_PRIVATE_KEY";
export const HAS_PRICE_KEY = "__sedaHasPrice";

// Use a getter function instead of a constant to ensure we read the decrypted value at runtime
export function getPrivateKey(): string | undefined {
	return process.env[PRIVATE_KEY_ENV_KEY];
}

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
	"HEAD",
];

export const LOG_LEVEL = Config.literal(
	"None",
	"All",
	"Fatal",
	"Error",
	"Warning",
	"Info",
	"Debug",
	"Trace",
	// Allows us to support the old log level format
	"none",
	"all",
	"fatal",
	"error",
	"warning",
	"info",
	"debug",
	"trace",
)("LOG_LEVEL")
	.pipe(Config.withDefault("Info"))
	.pipe(Config.map((input) => firstLetterToUpperCase(input) as Literal));

export const DATA_PROXY_ID = Config.string("DATA_PROXY_ID").pipe(
	Config.withDefault("data-proxy"),
	Config.withDescription("Used as the service name in telemetry"),
);
