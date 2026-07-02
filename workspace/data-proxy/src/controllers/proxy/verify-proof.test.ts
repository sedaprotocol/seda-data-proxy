import { describe, expect, it } from "bun:test";
import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { constants } from "@seda-protocol/data-proxy-sdk";
import { Effect, Either } from "effect";
import { Maybe } from "true-myth";
import type { Config } from "../../config/config-parser";
import {
	DEFAULT_PROXY_ROUTE_GROUP,
	DEFAULT_VERIFICATION_MAX_RETRIES,
	DEFAULT_VERIFICATION_RETRY_DELAY,
} from "../../constants";
import { VerifyProofError, verifyProof } from "./verify-proof";

const fastOnlyConfig: Config = {
	fastOnly: true,
	sedaFast: {
		enable: true,
		allowedClients: [
			"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
		],
	},
	modules: [],
	routes: [],
	verificationMaxRetries: DEFAULT_VERIFICATION_MAX_RETRIES,
	verificationRetryDelay: DEFAULT_VERIFICATION_RETRY_DELAY,
	routeGroup: DEFAULT_PROXY_ROUTE_GROUP,
	baseURL: Maybe.nothing(),
	statusEndpoints: { root: "status" },
};

describe("verifyProof", () => {
	it("rejects SEDA Core proofs in fastOnly mode", async () => {
		const result = await Effect.runPromise(
			Effect.either(
				verifyProof({
					headers: {
						[constants.PROOF_HEADER_KEY]: Buffer.from(
							"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f:1:00",
							"utf-8",
						).toString("base64"),
					},
					config: fastOnlyConfig,
					dataProxy: {} as DataProxy,
				}),
			),
		);

		if (Either.isRight(result)) {
			expect.unreachable("Should reject core proof in fastOnly mode");
		}

		expect(result.left).toBeInstanceOf(VerifyProofError);
		expect(result.left.message).toContain("not allowed in fastOnly mode");
	});
});
