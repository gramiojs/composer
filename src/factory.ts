import { compose } from "./compose.ts";
import { Composer, type RouteBuilder } from "./composer.ts";
import { EventQueue } from "./queue.ts";
import { nameMiddleware } from "./utils.ts";
import type {
	ComposedMiddleware,
	ComposerOptions,
	DeriveHandler,
	ErrorHandler,
	LazyFactory,
	MaybeArray,
	Middleware,
	MiddlewareInfo,
	Next,
	Scope,
	ScopedMiddleware,
	TraceHandler,
} from "./types.ts";

/**
 * Distributes over E to create a correlated union:
 * each event branch gets its own TEventMap entry + per-event derives.
 *
 * Single event → simple intersection.
 * Array of events → discriminated union where each branch has correct derives.
 */
type ResolveEventCtx<
	TOut extends object,
	TEventMap extends Record<string, any>,
	TDerives extends Record<string, object>,
	E extends string,
> = E extends any
	? TOut
		& (E extends keyof TEventMap ? TEventMap[E] : {})
		& (E extends keyof TDerives ? TDerives[E] : {})
	: never;

/** EventComposer interface — Composer + .on() + per-event derive tracking */
export interface EventComposer<
	TBase extends object,
	TEventMap extends Record<string, TBase>,
	TIn extends TBase = TBase,
	TOut extends TIn = TIn,
	TExposed extends object = {},
	TDerives extends Record<string, object> = {},
> {
	on<E extends keyof TEventMap & string>(
		event: MaybeArray<E>,
		handler: Middleware<ResolveEventCtx<TOut, TEventMap, TDerives, E>>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	decorate<D extends object>(
		values: D,
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed, TDerives>;
	decorate<D extends object>(
		values: D,
		options: { as: "scoped" | "global" },
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed & D, TDerives>;

	use(
		...middleware: Middleware<TOut>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	// Global derive
	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed, TDerives>;
	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
		options: { as: "scoped" | "global" },
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed & D, TDerives>;

	// Event-specific derive — adds to TDerives[E], NOT to global TOut
	derive<E extends keyof TEventMap & string, D extends object>(
		event: MaybeArray<E>,
		handler: DeriveHandler<ResolveEventCtx<TOut, TEventMap, TDerives, E>, D>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives & { [K in E]: D }>;

	guard<S extends TOut>(
		predicate: ((context: TOut) => context is S) | ((context: TOut) => boolean | Promise<boolean>),
		...middleware: Middleware<any>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	branch(
		predicate: ((context: TOut) => boolean | Promise<boolean>) | boolean,
		onTrue: Middleware<TOut>,
		onFalse?: Middleware<TOut>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		cases: Partial<Record<K, (composer: Composer<TOut, TOut, {}>) => Composer<any, any, any>>>,
		fallback?: (composer: Composer<TOut, TOut, {}>) => Composer<any, any, any>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;
	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		builder: (route: RouteBuilder<TOut, K>) => void,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;
	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		cases: Partial<Record<K, Middleware<TOut> | Middleware<TOut>[] | Composer<any, any, any>>>,
		fallback?: Middleware<TOut> | Middleware<TOut>[] | Composer<any, any, any>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	fork(
		...middleware: Middleware<TOut>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	tap(
		...middleware: Middleware<TOut>[]
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	lazy(
		factory: LazyFactory<TOut>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	onError(
		handler: ErrorHandler<TOut>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	when<UOut extends TOut>(
		condition: boolean,
		fn: (composer: Composer<TOut, TOut, {}>) => Composer<TOut, UOut, any>,
	): EventComposer<TBase, TEventMap, TIn, TOut & Partial<Omit<UOut, keyof TOut>>, TExposed, TDerives>;

	error(
		kind: string,
		errorClass: { new (...args: any): any; prototype: Error },
	): this;

	as(
		scope: "scoped" | "global",
	): EventComposer<TBase, TEventMap, TIn, TOut, TOut, TDerives>;

	group(
		fn: (composer: Composer<TOut, TOut, {}>) => void,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives>;

	// Extend another EventComposer — merges TDerives
	extend<UIn extends TBase, UOut extends UIn, UExposed extends object, UDerives extends Record<string, object>>(
		other: EventComposer<TBase, TEventMap, UIn, UOut, UExposed, UDerives>,
	): EventComposer<TBase, TEventMap, TIn, TOut & UExposed, TExposed, TDerives & UDerives>;

	// Extend plain Composer — TDerives unchanged
	extend<UIn extends object, UOut extends UIn, UExposed extends object>(
		other: Composer<UIn, UOut, UExposed>,
	): EventComposer<TBase, TEventMap, TIn, TOut & UExposed, TExposed, TDerives>;

	inspect(): MiddlewareInfo[];
	trace(handler: TraceHandler): this;

	compose(): ComposedMiddleware<TIn>;
	run(context: TIn, next?: Next): Promise<void>;

	"~": {
		middlewares: ScopedMiddleware<any>[];
		onErrors: ErrorHandler<any>[];
		extended: Set<string>;
		compiled: ComposedMiddleware<any> | null;
		name: string | undefined;
		seed: unknown;
		errorsDefinitions: Record<
			string,
			{ new (...args: any): any; prototype: Error }
		>;
		tracer: TraceHandler | undefined;
		Derives: TDerives;
	};
	invalidate(): void;
}

export interface EventComposerConstructor<
	TBase extends object,
	TEventMap extends Record<string, TBase>,
	TMethods extends Record<string, (...args: any[]) => any> = {},
> {
	new <
		TIn extends TBase = TBase,
		TOut extends TIn = TIn,
		TExposed extends object = {},
		TDerives extends Record<string, object> = {},
	>(
		options?: ComposerOptions,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives> & TMethods;
}

/**
 * Phantom type carrier for event map inference.
 * Returns `undefined` at runtime — exists purely for type-level inference
 * so that `TEventMap` can be inferred from the `types` config field.
 *
 * @example
 * ```ts
 * const { Composer } = createComposer({
 *   discriminator: (ctx: BaseCtx) => ctx.updateType,
 *   types: eventTypes<EventMap>(),
 *   methods: { hears(trigger) { return this.on("message", ...); } },
 * });
 * ```
 */
export function eventTypes<
	TEventMap extends Record<string, any>,
>(): TEventMap {
	return undefined as any;
}

/**
 * Creates a configured Composer class with type-safe .on() event discrimination.
 */
export function createComposer<
	TBase extends object,
	TEventMap extends Record<string, TBase> = {},
	TMethods extends Record<string, (...args: any[]) => any> = {},
>(config: {
	discriminator: (context: TBase) => string;
	types?: TEventMap;
	methods?: TMethods & ThisType<EventComposer<TBase, TEventMap, TBase, TBase, {}, {}>>;
}): {
	Composer: EventComposerConstructor<TBase, TEventMap, TMethods>;
	compose: typeof compose;
	EventQueue: typeof EventQueue;
} {
	class EventComposerImpl extends Composer<any, any, any> {
		on(
			event: string | string[],
			handler: Middleware<any>,
		) {
			const events = Array.isArray(event) ? event : [event];
			const eventLabel = events.join("|");
			const mw: Middleware<any> = (ctx: any, next: any) => {
				if (events.includes(config.discriminator(ctx))) {
					return handler(ctx, next);
				}
				return next();
			};
			nameMiddleware(mw, "on", eventLabel);
			this["~"].middlewares.push({ fn: mw, scope: "local", type: "on", name: eventLabel });
			this.invalidate();
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

			// derive(event, handler) — event-specific, always local scope
			const events = Array.isArray(eventOrHandler)
				? eventOrHandler
				: [eventOrHandler];
			const handler = handlerOrOptions;

			const eventLabel = events.join("|");
			const handlerName = handler.name || undefined;
			const deriveName = handlerName ? `${eventLabel}:${handlerName}` : eventLabel;
			const mw: Middleware<any> = async (ctx, next) => {
				if (events.includes(config.discriminator(ctx))) {
					Object.assign(ctx, await handler(ctx));
				}
				return next();
			};

			nameMiddleware(mw, "derive", deriveName);
			this["~"].middlewares.push({ fn: mw, scope: "local", type: "derive", name: deriveName });
			this.invalidate();
			return this;
		}
	}

	if (config.methods) {
		for (const [name, fn] of Object.entries(config.methods)) {
			if (name in EventComposerImpl.prototype) {
				throw new Error(`Custom method "${name}" conflicts with built-in method`);
			}
			Object.defineProperty(EventComposerImpl.prototype, name, {
				value: fn,
				writable: true,
				configurable: true,
				enumerable: false,
			});
		}
	}

	return {
		Composer: EventComposerImpl as any,
		compose,
		EventQueue,
	};
}
