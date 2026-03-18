import { Data } from "effect";

export class FailedToVerifyProofError extends Data.TaggedError("FailedToVerifyProofError")<{ error: string | unknown }> {
	message = `Failed to verify proof: ${this.error}`;
}

export class HttpClientRequestFailedError extends Data.TaggedError("HttpClientRequestFailedError")<{ error: string | unknown }> {
	message = `HTTP client request failed: ${this.error}`;
}

export class FailedToParseResponseBodyError extends Data.TaggedError("FailedToParseResponseBodyError")<{
	error: string | unknown;
	status?: number;
}> {
	message = `Failed to parse response body: ${this.error} ${this.status ? `status: ${this.status}` : ""}`;
}

export class UnknownError extends Data.TaggedError("UnknownError")<{
	error: string | unknown;
}> {
	message = `Unknown error: ${this.error}`;
}

export class UpstreamRequestFailedError extends Data.TaggedError("UpstreamRequestFailedError")<{
	error: string | unknown;
	routePath: string;
}> {
	message = `Upstream request failed for route ${this.routePath}: ${this.error}`;
}

export class NotOkUpstreamResponseError extends Data.TaggedError("NotOkUpstreamResponseError")<{
	status: number;
	body: string;
	routePath: string;
}> {
	message = `Upstream response for route ${this.routePath} is not ok: ${this.status} body: ${this.body}`;
}

export class FailedToParseConfigError extends Data.TaggedError("FailedToParseConfigError")<{ error: string | unknown }> {
	message = `Failed to parse config: ${this.error}`;
}
