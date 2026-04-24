import { createDefaultResponseHeaders } from "../utils/create-headers";

type TaggedError = {
	_tag: string;
	message: string;
};

export function createErrorResponse(error: TaggedError, status: number) {
	const taggedErrorExceptMessage = {
		...error,
		error: undefined,
		message: undefined,
		data: undefined, // can be very large for errors like QueryJsonError
	};

	return new Response(
		JSON.stringify({
			data_proxy_error: error.message,
			...taggedErrorExceptMessage,
		}),
		{
			status,
			headers: createDefaultResponseHeaders(),
		},
	);
}
