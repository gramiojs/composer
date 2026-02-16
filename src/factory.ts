import { compose } from "./compose.ts";
import { Composer } from "./composer.ts";
import { EventQueue } from "./queue.ts";
import type {
	ComposedMiddleware,
	ComposerOptions,
	DeriveHandler,
	ErrorHandler,
	LazyFactory,
	MaybeArray,
	Middleware,
	Next,
	Scope,
	ScopedMiddleware,
} from "./types.ts";

/** EventComposer interface — Composer + .on() with all chainable methods returning EventComposer */
export interface EventComposer<
	TBase extends object,
	TEventMap extends Record<string, TBase>,
	TIn extends TBase = TBase,
	TOut extends TIn = TIn,
	TExposed extends object = {},
> {
	on<E extends keyof TEventMap & string>(
		event: MaybeArray<E>,
		handler: Middleware<TOut & TEventMap[E]>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	use(
		...middleware: Middleware<TOut>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed>;
	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
		options: { as: "scoped" | "global" },
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed & D>;
	derive<E extends keyof TEventMap & string, D extends object>(
		event: MaybeArray<E>,
		handler: DeriveHandler<TOut & TEventMap[E], D>,
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed>;
	derive<E extends keyof TEventMap & string, D extends object>(
		event: MaybeArray<E>,
		handler: DeriveHandler<TOut & TEventMap[E], D>,
		options: { as: "scoped" | "global" },
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed & D>;

	guard<S extends TOut>(
		predicate: ((context: TOut) => context is S) | ((context: TOut) => boolean | Promise<boolean>),
		...middleware: Middleware<any>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	branch(
		predicate: ((context: TOut) => boolean | Promise<boolean>) | boolean,
		onTrue: Middleware<TOut>,
		onFalse?: Middleware<TOut>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	route<K extends string>(
		router: (context: TOut) => K | Promise<K>,
		cases: Partial<Record<K, Middleware<TOut>>>,
		fallback?: Middleware<TOut>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	fork(
		...middleware: Middleware<TOut>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	tap(
		...middleware: Middleware<TOut>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	lazy(
		factory: LazyFactory<TOut>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	onError(
		handler: ErrorHandler<TOut>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	error(
		kind: string,
		errorClass: { new (...args: any): any; prototype: Error },
	): this;

	as(
		scope: "scoped" | "global",
	): EventComposer<TBase, TEventMap, TIn, TOut, TOut>;

	group(
		fn: (composer: Composer<TOut, TOut, {}>) => void,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;

	extend<UIn extends object, UOut extends UIn, UExposed extends object>(
		other: Composer<UIn, UOut, UExposed>,
	): EventComposer<TBase, TEventMap, TIn, TOut & UExposed, TExposed>;

	compose(): ComposedMiddleware<TIn>;
	run(context: TIn, next?: Next): Promise<void>;

	_: {
		middlewares: ScopedMiddleware<any>[];
		extended: Set<string>;
		compiled: ComposedMiddleware<any> | null;
		name: string | undefined;
		seed: unknown;
		errorsDefinitions: Record<
			string,
			{ new (...args: any): any; prototype: Error }
		>;
	};
	"~": EventComposer<TBase, TEventMap, TIn, TOut, TExposed>["_"];
	invalidate(): void;
}

export interface EventComposerConstructor<
	TBase extends object,
	TEventMap extends Record<string, TBase>,
> {
	new <
		TIn extends TBase = TBase,
		TOut extends TIn = TIn,
		TExposed extends object = {},
	>(
		options?: ComposerOptions,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed>;
}

/**
 * Creates a configured Composer class with type-safe .on() event discrimination.
 */
export function createComposer<
	TBase extends object,
	TEventMap extends Record<string, TBase> = {},
>(config: {
	discriminator: (context: TBase) => string;
}): {
	Composer: EventComposerConstructor<TBase, TEventMap>;
	compose: typeof compose;
	EventQueue: typeof EventQueue;
} {
	class EventComposerImpl extends Composer<any, any, any> {
		on(
			event: string | string[],
			handler: Middleware<any>,
		) {
			const events = Array.isArray(event) ? event : [event];
			super.use((ctx: any, next: any) => {
				if (events.includes(config.discriminator(ctx))) {
					return handler(ctx, next);
				}
				return next();
			});
			return this;
		}

		derive(
			eventOrHandler: any,
			handlerOrOptions?: any,
			maybeOptions?: any,
		) {
			// derive(handler) or derive(handler, options)
			if (typeof eventOrHandler === "function") {
				return super.derive(eventOrHandler, handlerOrOptions);
			}

			// derive(event, handler) or derive(event, handler, options)
			const events = Array.isArray(eventOrHandler)
				? eventOrHandler
				: [eventOrHandler];
			const handler = handlerOrOptions;
			const options = maybeOptions;

			const mw: Middleware<any> = async (ctx, next) => {
				if (events.includes(config.discriminator(ctx))) {
					Object.assign(ctx, await handler(ctx));
				}
				return next();
			};

			const scope: Scope = options?.as ?? "local";
			this._.middlewares.push({ fn: mw, scope });
			this.invalidate();
			return this;
		}
	}

	return {
		Composer: EventComposerImpl as any,
		compose,
		EventQueue,
	};
}
