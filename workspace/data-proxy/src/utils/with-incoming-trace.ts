import * as Tracer from "@effect/opentelemetry/Tracer";
import { getCurrentSpan } from "@elysia/opentelemetry";
import type { Effect } from "effect";

export const withIncomingTrace = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const currentSpan = getCurrentSpan();
	if (!currentSpan) {
		return effect;
	}

	const spanContext = currentSpan.spanContext();
	return Tracer.withSpanContext(effect, spanContext);
};
