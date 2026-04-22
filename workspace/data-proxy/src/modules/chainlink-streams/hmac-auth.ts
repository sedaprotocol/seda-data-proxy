import crypto from "node:crypto";

/**
 * Generate HMAC authentication headers for Chainlink Data Streams API.
 *
 * stringToSign = "${method} ${path} ${bodyHash} ${apiKey} ${timestamp}"
 * signature = HMAC-SHA256(apiSecret, stringToSign)
 *
 * `timestamp` is a parameter so tests can inject a fixed value.
 *
 * Spec: https://docs.chain.link/data-streams/reference/data-streams-api/authentication
 */
export function generateHmacAuth(
	apiKey: string,
	apiSecret: string,
	method: string,
	path: string,
	body: string,
	timestamp: string,
): {
	authorization: string;
	timestamp: string;
	signature: string;
} {
	const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
	const stringToSign = `${method} ${path} ${bodyHash} ${apiKey} ${timestamp}`;
	const signature = crypto
		.createHmac("sha256", apiSecret)
		.update(stringToSign)
		.digest("hex");

	return {
		authorization: apiKey,
		timestamp,
		signature,
	};
}
