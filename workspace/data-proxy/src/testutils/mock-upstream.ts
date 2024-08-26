import { http, type HttpResponseResolver, passthrough } from "msw";
import { setupServer } from "msw/node";
export { HttpResponse } from "msw";

const TEST_UPSTREAM_BASE = "https://proxy-upstream.com";

export const TEST_LOCAL_PROXY_PORT = 9008;
const TEST_LOCAL_PROXY = `http://localhost:${TEST_LOCAL_PROXY_PORT}`;

const handlers = [
	// Don't touch requests that go to the data proxy
	http.all(`${TEST_LOCAL_PROXY}*`, () => {
		return passthrough();
	}),
];

export const server = setupServer(...handlers);

type Method = keyof typeof http;

export function registerHandler(
	method: Method,
	path: string,
	resolver: HttpResponseResolver,
): {
	upstreamUrl: string;
	proxyUrl: string;
	path: string;
} {
	const upstreamUrl = `${TEST_UPSTREAM_BASE}${path}`;
	server.use(http[method](upstreamUrl, resolver));

	return {
		upstreamUrl,
		proxyUrl: `${TEST_LOCAL_PROXY}${path}`,
		path,
	};
}
