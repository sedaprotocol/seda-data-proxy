import { Context, Data, Effect, Layer } from "effect";
import type { Route } from "../config/config-parser";

export class FailedToHandleRequest extends Data.TaggedError(
	"FailedToHandleRequest",
)<{ msg: string; status?: number }> {
	message = `Failed to handle request: ${this.msg}`;
	status = 500;
}

export interface ModuleHandlers {
	start: () => Effect.Effect<void>;
	handleRequest: (
		route: Route,
		params: Record<string, string>,
		request: Request,
		body?: string,
	) => Effect.Effect<Response, FailedToHandleRequest>;
}

export class ModuleService extends Context.Tag("ModuleService")<
	ModuleService,
	ModuleHandlers
>() {}

export const EmptyModuleService = Layer.effect(
	ModuleService,
	Effect.gen(function* () {
		return ModuleService.of({
			start: () => Effect.succeed(undefined),
			handleRequest: (
				route: Route,
				params: Record<string, string>,
				request: Request,
				body?: string,
			) => Effect.succeed(new Response("Not implemented", { status: 500 })),
		});
	}),
);
