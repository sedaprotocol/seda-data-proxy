import { trySync } from "@seda-protocol/utils";
import { Result } from "true-myth";
import { mergeUrlSearchParams } from "./search-params";

export function injectSearchParamsInUrl(
	targetUrl: string,
	searchParams: URLSearchParams,
): Result<URL, string> {
	const target: Result<URL, unknown> = trySync(() => new URL(targetUrl));

	if (target.isErr) {
		return Result.err("Failed to parse target URL");
	}

	const finalSearchParams = mergeUrlSearchParams(
		searchParams,
		target.value.searchParams,
	);
	target.value.search = finalSearchParams.toString();

	return Result.ok(target.value);
}
