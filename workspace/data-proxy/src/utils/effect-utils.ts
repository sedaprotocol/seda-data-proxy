import { Effect } from "effect";
import { Result } from "true-myth";

/**
 * Converts a Promise to an Effect, handling error conversion.
 *
 * This utility function wraps a Promise in an Effect, automatically converting
 * any thrown errors to Error instances for consistent error handling.
 *
 * @param callback - The Promise to convert to an Effect
 * @returns An Effect that will resolve with the Promise's value or fail with an Error
 *
 * @example
 * ```typescript
 * // Convert a simple Promise to Effect
 * const fetchUser = asyncToEffect(
 *   fetch('/api/user/1').then(res => res.json())
 * );
 *
 * // Use with Effect.runPromise
 * const user = await Effect.runPromise(fetchUser);
 *
 * // Handle errors
 * const result = await Effect.runPromise(
 *   Effect.either(fetchUser)
 * );
 * ```
 */
export function asyncToEffect<T>(
	callback: Promise<T>,
): Effect.Effect<T, Error> {
	return Effect.tryPromise({
		try: () => callback,
		catch: (error: unknown) => {
			if (error instanceof Error) {
				return error;
			}
			return new Error(String(error));
		},
	});
}

/**
 * Converts an Effect to an async Result, handling both success and error cases.
 *
 * This function runs an Effect and wraps the result in a Result type from true-myth,
 * providing a consistent way to handle both success and error outcomes.
 *
 * @param effect - The Effect to convert to an async Result
 * @returns A Promise that resolves to a Result containing either the success value or an Error
 *
 * @example
 * ```typescript
 * // Convert an Effect to async Result
 * const userEffect = Effect.succeed({ id: 1, name: "John" });
 * const result = await effectToAsyncResult(userEffect);
 *
 * if (result.isOk) {
 *   console.log("User:", result.value);
 * } else {
 *   console.error("Error:", result.error);
 * }
 *
 * // With error handling
 * const errorEffect = Effect.fail(new Error("User not found"));
 * const errorResult = await effectToAsyncResult(errorEffect);
 * // errorResult.isErr will be true
 * ```
 */
export async function effectToAsyncResult<T, E>(
	effect: Effect.Effect<T, E>,
): Promise<Result<T, Error>> {
	try {
		const result = await Effect.runPromise(effect);
		return Result.ok(result);
	} catch (error) {
		if (error instanceof Error) {
			return Result.err(error);
		}

		return Result.err(new Error(String(error)));
	}
}

/**
 * Converts a Promise of Result to an Effect.
 *
 * This function takes a Promise that resolves to a Result and converts it to an Effect,
 * allowing seamless integration between async Result patterns and Effect workflows.
 *
 * @param callback - A Promise that resolves to a Result
 * @returns An Effect that will succeed with the Result's value or fail with the Result's error
 *
 * @example
 * ```typescript
 * // Convert a Promise<Result> to Effect
 * const fetchUserResult = fetch('/api/user/1')
 *   .then(res => res.ok ? Result.ok(res.json()) : Result.err(new Error('Not found')));
 *
 * const userEffect = asyncResultToEffect(fetchUserResult);
 *
 * // Use in Effect pipeline
 * const result = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const user = yield* userEffect;
 *     return user;
 *   })
 * );
 * ```
 */
export function asyncResultToEffect<T, E>(
	callback: Promise<Result<T, E>>,
): Effect.Effect<T, E> {
	return Effect.async((resume) => {
		callback.then((result) => {
			if (result.isErr) {
				resume(Effect.fail(result.error));
			} else {
				resume(Effect.succeed(result.value));
			}
		});
	});
}

/**
 * Converts an Effect to a synchronous Result.
 *
 * This function runs an Effect synchronously and wraps the result in a Result type,
 * providing immediate access to either the success value or error without async/await.
 *
 * @param effect - The Effect to convert to a synchronous Result
 * @returns A Result containing either the success value or an Error
 *
 * @example
 * ```typescript
 * // Convert a simple Effect to sync Result
 * const simpleEffect = Effect.succeed("Hello World");
 * const result = effectToSyncResult(simpleEffect);
 *
 * if (result.isOk) {
 *   console.log(result.value); // "Hello World"
 * }
 *
 * // With error handling
 * const errorEffect = Effect.fail(new Error("Something went wrong"));
 * const errorResult = effectToSyncResult(errorEffect);
 *
 * if (errorResult.isErr) {
 *   console.error(errorResult.error.message); // "Something went wrong"
 * }
 *
 * // Note: Only use with synchronous Effects
 * // For async Effects, use effectToAsyncResult instead
 * ```
 */
export function effectToSyncResult<T, E>(
	effect: Effect.Effect<T, E>,
): Result<T, Error> {
	try {
		const result = Effect.runSync(effect);
		return Result.ok(result);
	} catch (error) {
		if (error instanceof Error) {
			return Result.err(error);
		}

		return Result.err(new Error(String(error)));
	}
}
