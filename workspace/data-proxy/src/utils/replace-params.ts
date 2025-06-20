import { envVarRegex } from "../config-parser";

/**
 * Replaces parameters in the input string with values from the given params object and the
 * environment variables.
 */
export function replaceParams(
	input: string,
	params: Record<string, string> | undefined,
): string {
	let result = input;

	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (key === "*") {
				// Special use case where they do not use : for *
				result = result.replaceAll(`{${key}}`, value);
			}

			result = result.replaceAll(`{:${key}}`, value);
		}
	}

	// Allow replacement of {$ENV_VARIABLE} in case data providers want to safely store their API keys
	for (const match of result.matchAll(envVarRegex)) {
		const envKey = match[1].replace("$", "");
		const envVar = process.env[envKey] ?? "";
		result = result.replaceAll(match[0], envVar);
	}

	return result;
}
