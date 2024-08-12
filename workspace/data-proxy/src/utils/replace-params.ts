export function replaceParams(
	input: string,
	params: Record<string, string>,
): string {
	let result = input;

	for (const [key, value] of Object.entries(params)) {
		if (key === "*") {
			// Special use case where they do not use : for *
			result = result.replaceAll(`{${key}}`, value);
		}

		result = result.replaceAll(`{:${key}}`, value);
	}

	// Allow replacement of {$ENV_VARIABLE} in case data providers want to safely store their API keys
	const envVariablesRegex = new RegExp(/{(\$[^}]+)}/g, "g");
	const envMatches = result.matchAll(envVariablesRegex);

	for (const match of envMatches) {
		const envKey = match[1].replace("$", "");

		// TODO: This should be checked at config parse level
		const envVar = process.env[envKey] ?? "";
		result = result.replaceAll(match[0], envVar);
	}

	return result;
}
