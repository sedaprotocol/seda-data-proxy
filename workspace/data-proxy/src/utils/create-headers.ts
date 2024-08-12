import type { SignedData } from "@seda-protocol/data-proxy-sdk";
import { PUBLIC_KEY_HEADER_KEY, SIGNATURE_HEADER_KEY } from "../constants";

export function createDefaultResponseHeaders() {
	const headers = new Headers();
	headers.append("content-type", "application/json");

	return headers;
}

export function createSignedResponseHeaders(
	signature: SignedData,
	headers = new Headers(),
) {
	headers.append(SIGNATURE_HEADER_KEY, signature.signature);
	headers.append(PUBLIC_KEY_HEADER_KEY, signature.publicKey);

	return headers;
}
