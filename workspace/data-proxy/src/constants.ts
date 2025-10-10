import { Environment } from "@seda-protocol/data-proxy-sdk";
import type { HTTPMethod } from "elysia";

// Server constants
export const SERVER_PORT = process.env.SERVER_PORT ?? "5384";
export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
export const LOG_FILE_DIR = process.env.LOG_FILE_DIR ?? "./logs/";
export const LOG_FILE_LOG_LEVEL = process.env.LOG_FILE_LOG_LEVEL ?? "debug";
export const LOG_FILE_MAX_FILES = process.env.LOG_FILE_MAX_FILES ?? "14d";
export const LOG_FILE_DATE_PATTERN =
	process.env.LOG_FILE_DATE_PATTERN ?? "YYYY-MM-DD";

// Environment constants
export const DEFAULT_ENVIRONMENT: Environment =
	(process.env.SEDA_ENV as Environment) ?? Environment.Testnet;

// App constants
export const JSON_PATH_HEADER_KEY = "x-seda-json-path";

// Verification constants
export const DEFAULT_VERIFICATION_MAX_RETRIES = 2;
export const DEFAULT_VERIFICATION_RETRY_DELAY = 1000;

export const PRIVATE_KEY_ENV_KEY = "SEDA_DATA_PROXY_PRIVATE_KEY";
export const PRIVATE_KEY = process.env[PRIVATE_KEY_ENV_KEY];

// Diagnostic logging for environment variable
if (PRIVATE_KEY) {
	console.log("🔍 DEBUG [constants.ts]: SEDA_DATA_PROXY_PRIVATE_KEY is set");
	console.log(`🔍 DEBUG [constants.ts]: Value length: ${PRIVATE_KEY.length}`);
	console.log(
		`🔍 DEBUG [constants.ts]: First 10 chars: "${PRIVATE_KEY.substring(0, 10)}"`,
	);
	console.log(
		`🔍 DEBUG [constants.ts]: Last 10 chars: "${PRIVATE_KEY.substring(PRIVATE_KEY.length - 10)}"`,
	);
} else {
	console.log(
		"🔍 DEBUG [constants.ts]: SEDA_DATA_PROXY_PRIVATE_KEY is NOT set",
	);
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
