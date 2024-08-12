import { expect } from "bun:test";
import type { Result, ResultNS } from "true-myth";

export function assertValue<T>(
	value: unknown,
	expected: T,
): asserts value is T {
	expect(value).toEqual(expected);
}

export function assertIsErrorResult<T>(
	result: Result<unknown, T>,
): asserts result is ResultNS.Err<unknown, T> {
	assertValue(result.isErr, true);
}

export function assertIsOkResult<T>(
	result: Result<T, unknown>,
): asserts result is ResultNS.Ok<T, unknown> {
	assertValue(result.isOk, true);
}

export function getResultError<T>(result: Result<unknown, T>): T {
	assertIsErrorResult(result);
	return result.error;
}

export function getResultOk<T>(result: Result<T, unknown>): T {
	assertIsOkResult(result);
	return result.value;
}
