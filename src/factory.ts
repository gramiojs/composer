import { compose } from "./compose.ts";
import { Composer } from "./composer.ts";
import { EventQueue } from "./queue.ts";
import type { MaybeArray, Middleware } from "./types.ts";

/**
 * Creates a configured Composer class with type-safe .on() event discrimination.
 */
export function createComposer<
	TBase extends object,
	TEventMap extends Record<string, TBase> = {},
>(config: {
	discriminator: (context: TBase) => string;
}) {
	class EventComposer<
		TIn extends TBase = TBase,
		TOut extends TIn = TIn,
		TExposed extends object = {},
	> extends Composer<TIn, TOut, TExposed> {
		on<E extends keyof TEventMap & string>(
			event: MaybeArray<E>,
			handler: Middleware<TOut & TEventMap[E]>,
		): EventComposer<TIn, TOut, TExposed> {
			const events = Array.isArray(event) ? event : [event];
			return this.use(((ctx: any, next: any) => {
				if (events.includes(config.discriminator(ctx) as E)) {
					return handler(ctx, next);
				}
				return next();
			}) as Middleware<TOut>) as unknown as EventComposer<TIn, TOut, TExposed>;
		}
	}

	return {
		Composer: EventComposer as {
			new <
				TIn extends TBase = TBase,
				TOut extends TIn = TIn,
				TExposed extends object = {},
			>(
				options?: { name?: string; seed?: unknown },
			): EventComposer<TIn, TOut, TExposed>;
		},
		compose,
		EventQueue,
	};
}
