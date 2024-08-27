import { http, type HttpResponseResolver, passthrough } from "msw";
import { setupServer } from "msw/node";
export { HttpResponse } from "msw";

const TEST_UPSTREAM_BASE = "https://proxy-upstream.com";

// TODO: either reuse a single proxy entry or figure out why stopping a server doesn't actually stop it.
// When calling `await proxy.stop()` after a test and spinning up a new proxy in the next test the first server still
// receives the request.
// https://github.com/sedaprotocol/seda-data-proxy/issues/11
let TEST_LOCAL_PROXY_PORT = 9000;
const TEST_LOCAL_PROXY_BASE = "http://localhost";

const handlers = [
	// Don't touch requests that go to the data proxy
	http.all(`${TEST_LOCAL_PROXY_BASE}*`, () => {
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
	port: number;
} {
	const upstreamUrl = `${TEST_UPSTREAM_BASE}${path}`;
	server.use(http[method](upstreamUrl, resolver));

	return {
		upstreamUrl,
		proxyUrl: `${TEST_LOCAL_PROXY_BASE}:${TEST_LOCAL_PROXY_PORT}${path}`,
		path,
		port: TEST_LOCAL_PROXY_PORT++,
	};
}
