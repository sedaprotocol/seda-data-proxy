import { Duration, Option } from "effect";
import * as v from "valibot";

/** `"infinity"` disables expiry, since `Duration.decodeUnknown` does not parse it. */
export const priceCacheTtlField = (fallback = "1 hour") =>
	v.pipe(
		v.optional(v.union([v.number(), v.string()]), fallback),
		v.transform((value) =>
			value === "infinity"
				? Duration.infinity
				: Option.getOrThrowWith(
						Duration.decodeUnknown(value),
						() => new Error("Invalid priceCacheTtl duration"),
					),
		),
	);
