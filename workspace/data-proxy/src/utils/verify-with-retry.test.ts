import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Maybe, Result } from "true-myth";
import type { Logger } from "winston";
import { verifyWithRetry } from "./verify-with-retry";

type VerificationResult = {
	isValid: boolean;
	currentHeight: bigint;
	status: string;
};

describe("verifyWithRetry", () => {
	const loggerStub: Logger = {
		silly: () => {},
		warn: () => {},
	} as unknown as Logger;

	const mockProof = "test-proof";

	let mockDataProxy: DataProxy;
	beforeEach(() => {
		mockDataProxy = {
			verify: mock(() => {}),
		} as unknown as DataProxy;
	});

	const testDefaultMaxAttempts = 2;
	const testDefaultRetryDelay = () => 1;

	it("should return successful verification on first attempt", async () => {
		const mockVerification = {
			isValid: true,
			currentHeight: 100n,
			status: "valid",
		};

		mockDataProxy.verify = mock(() =>
			Promise.resolve(Result.ok(mockVerification)),
		);

		const result = await verifyWithRetry(
			loggerStub,
			mockDataProxy,
			mockProof,
			Maybe.nothing(),
			testDefaultMaxAttempts,
			testDefaultRetryDelay,
		);

		expect(result.isOk).toBe(true);
		const verification = result.unwrapOr(null);
		expect(verification).not.toBeNull();
		expect(verification).toEqual(mockVerification);
		expect(mockDataProxy.verify).toHaveBeenCalledTimes(1);
	});

	it("should retry when the verification request fails", async () => {
		const mockVerification = {
			isValid: true,
			currentHeight: 100n,
			status: "valid",
		};

		let callCount = 0;
		mockDataProxy.verify = mock(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve(Result.err("Network error"));
			}
			return Promise.resolve(Result.ok(mockVerification));
		});

		const result = await verifyWithRetry(
			loggerStub,
			mockDataProxy,
			mockProof,
			Maybe.nothing(),
			testDefaultMaxAttempts,
			testDefaultRetryDelay,
		);

		expect(result.isOk).toBe(true);
		const verification = result.unwrapOr(null);
		expect(verification).not.toBeNull();
		expect(verification as VerificationResult).toEqual(mockVerification);
		expect(mockDataProxy.verify).toHaveBeenCalledTimes(2);
	});

	it.each(["not_eligible", "data_request_not_found", "not_staker"])(
		"should retry for status %s when height is behind but within MAX_HEIGHT_DIFFERENCE",
		async (status) => {
			const eligibleHeight = Maybe.just(102n);

			mockDataProxy.verify = mock(() => {
				return Promise.resolve(
					Result.ok({
						isValid: false,
						currentHeight: 100n,
						status,
					}),
				);
			});

			const result = await verifyWithRetry(
				loggerStub,
				mockDataProxy,
				mockProof,
				eligibleHeight,
				testDefaultMaxAttempts,
				testDefaultRetryDelay,
			);

			expect(result.isOk).toBe(true);
			const verification = result.unwrapOr(null);
			expect(verification).not.toBeNull();
			expect((verification as VerificationResult).status).toBe(status);
			expect(mockDataProxy.verify).toHaveBeenCalledTimes(2);
		},
	);

	it("should not retry when proof is invalid", async () => {
		const mockVerification = {
			isValid: false,
			currentHeight: 100n,
			status: "invalid_signature",
		};
		mockDataProxy.verify = mock(() =>
			Promise.resolve(Result.ok(mockVerification)),
		);

		const result = await verifyWithRetry(
			loggerStub,
			mockDataProxy,
			mockProof,
			Maybe.just(102n),
			testDefaultMaxAttempts,
			testDefaultRetryDelay,
		);

		expect(result.isOk).toBe(true);
		const verification = result.unwrapOr(null);
		expect(verification).not.toBeNull();
		expect(verification as VerificationResult).toEqual(mockVerification);
		expect(mockDataProxy.verify).toHaveBeenCalledTimes(1);
	});

	it("should not retry when eligible height is not provided", async () => {
		const mockVerification = {
			isValid: false,
			currentHeight: 100n,
			status: "height_mismatch",
		};
		mockDataProxy.verify = mock(() =>
			Promise.resolve(Result.ok(mockVerification)),
		);

		const result = await verifyWithRetry(
			loggerStub,
			mockDataProxy,
			mockProof,
			Maybe.nothing(),
			testDefaultMaxAttempts,
			testDefaultRetryDelay,
		);

		expect(result.isOk).toBe(true);
		const verification = result.unwrapOr(null);
		expect(verification).not.toBeNull();
		expect(verification as VerificationResult).toEqual(mockVerification);
		expect(mockDataProxy.verify).toHaveBeenCalledTimes(1);
	});

	it("should not retry when height difference is too large", async () => {
		const eligibleHeight = Maybe.just(105n);
		const mockVerification = {
			isValid: false,
			currentHeight: 100n,
			status: "height_mismatch",
		};
		mockDataProxy.verify = mock(() =>
			Promise.resolve(Result.ok(mockVerification)),
		);

		const result = await verifyWithRetry(
			loggerStub,
			mockDataProxy,
			mockProof,
			eligibleHeight,
			testDefaultMaxAttempts,
			testDefaultRetryDelay,
		);

		expect(result.isOk).toBe(true);
		const verification = result.unwrapOr(null);
		expect(verification).not.toBeNull();
		expect(verification as VerificationResult).toEqual(mockVerification);
		expect(mockDataProxy.verify).toHaveBeenCalledTimes(1);
	});

	it("should respect maxAttempts parameter", async () => {
		const mockVerification = {
			isValid: false,
			currentHeight: 100n,
			status: "height_mismatch",
		};
		mockDataProxy.verify = mock(() =>
			Promise.resolve(Result.ok(mockVerification)),
		);

		const result = await verifyWithRetry(
			loggerStub,
			mockDataProxy,
			mockProof,
			Maybe.just(101n),
			3,
			testDefaultRetryDelay,
		);

		expect(result.isOk).toBe(true);
		const verification = result.unwrapOr(null);
		expect(verification).not.toBeNull();
		expect(verification as VerificationResult).toEqual(mockVerification);
		expect(mockDataProxy.verify).toHaveBeenCalledTimes(3);
	});

	it("should use custom retry delay function", async () => {
		const mockVerification = {
			isValid: false,
			currentHeight: 100n,
			status: "not_eligible",
		};
		mockDataProxy.verify = mock(() => {
			return Promise.resolve(Result.ok(mockVerification));
		});

		const customDelay = mock(() => 2);

		await verifyWithRetry(
			loggerStub,
			mockDataProxy,
			mockProof,
			Maybe.just(101n),
			4,
			customDelay,
		);

		expect(customDelay).toHaveBeenCalledTimes(3);
		expect(customDelay).toHaveBeenNthCalledWith(1, 2);
		expect(customDelay).toHaveBeenNthCalledWith(2, 3);
		expect(customDelay).toHaveBeenNthCalledWith(3, 4);
	});
});
