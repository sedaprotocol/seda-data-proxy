import { Effect, Queue, Stream } from "effect";

export interface InboundControl<A> {
	offer: (event: A) => void;
}

/**
 * Drain uncommon inbound events on a daemon fiber so the WebSocket tick
 * callback can stay plain JavaScript (no Effect, no runSync). See DEVELOPING.md.
 */
export const forkInboundControl = <A>(
	handle: (event: A) => Effect.Effect<unknown>,
): Effect.Effect<InboundControl<A>> =>
	Effect.gen(function* () {
		const queue = yield* Queue.unbounded<A>();
		yield* Effect.forkDaemon(
			Stream.fromQueue(queue).pipe(
				Stream.mapEffect(handle, { concurrency: 1 }),
				Stream.runDrain,
			),
		);
		return {
			offer: (event: A) => {
				queue.unsafeOffer(event);
			},
		};
	});
