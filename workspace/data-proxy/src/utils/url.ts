import { mergeUrlSearchParams } from "./search-params";

export function injectSearchParamsInUrl(
	targetUrl: string,
	searchParams: URLSearchParams,
): URL {
	const target = new URL(targetUrl);
	const finalSearchParams = mergeUrlSearchParams(
		searchParams,
		target.searchParams,
	);
	target.search = finalSearchParams.toString();

	return target;
}
