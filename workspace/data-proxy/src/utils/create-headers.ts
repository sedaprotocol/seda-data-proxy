import { constants, type SignedData } from "@seda-protocol/data-proxy-sdk";

export function createDefaultResponseHeaders() {
	const headers = new Headers();
	headers.append("content-type", "application/json");

	return headers;
}

export function createOptionsResponse(publicKeyHex: string, version: string) {
	return new Response(null, {
		headers: {
			[constants.PUBLIC_KEY_HEADER_KEY]: publicKeyHex,
			[constants.SIGNATURE_VERSION_HEADER_KEY]: version,
		},
	});
}

export function createSignedResponseHeaders(
	signature: SignedData,
	headers = new Headers(),
) {
	headers.append(constants.SIGNATURE_HEADER_KEY, signature.signature);
	headers.append(constants.PUBLIC_KEY_HEADER_KEY, signature.publicKey);
	headers.append(constants.SIGNATURE_VERSION_HEADER_KEY, signature.version);

	return headers;
}
