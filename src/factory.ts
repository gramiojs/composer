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
	MacroDef,
	MacroDefinitions,
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

/**
 * Given an event map and a Narrowing type, yields the union of event names
 * whose context type contains all keys from Narrowing.
 */
export type CompatibleEvents<
	TEventMap extends Record<string, any>,
	Narrowing,
> = {
	[E in keyof TEventMap & string]:
		keyof Narrowing & string extends keyof TEventMap[E] ? E : never
}[keyof TEventMap & string];

/** EventComposer interface — Composer + .on() + per-event derive tracking + custom methods */
export interface EventComposer<
	TBase extends object,
	TEventMap extends Record<string, TBase>,
	TIn extends TBase = TBase,
	TOut extends TIn = TIn,
	TExposed extends object = {},
	TDerives extends Record<string, object> = {},
	TMethods extends Record<string, (...args: any[]) => any> = {},
	TMacros extends MacroDefinitions = {},
> {
	// --- Methods that preserve generics → return `this` (keeps TMethods in chain) ---

	// Filter-only overload (type-narrowing predicate — auto-discovers matching events)
	on<Narrowing>(
		filter: (ctx: any) => ctx is Narrowing,
		handler: Middleware<
			ResolveEventCtx<TOut, TEventMap, TDerives, CompatibleEvents<TEventMap, Narrowing>> & Narrowing
		>,
	): this;

	// Filter-only overload (boolean — no narrowing, handler gets TOut)
	on(
		filter: (ctx: TOut) => boolean,
		handler: Middleware<TOut>,
	): this;

	// Filter overload (type-narrowing predicate)
	on<E extends keyof TEventMap & string, Narrowing>(
		event: MaybeArray<E>,
		filter: (ctx: any) => ctx is Narrowing,
		handler: Middleware<ResolveEventCtx<TOut, TEventMap, TDerives, E> & Narrowing>,
	): this;

	// Filter overload (boolean, no narrowing)
	on<E extends keyof TEventMap & string>(
		event: MaybeArray<E>,
		filter: (ctx: ResolveEventCtx<TOut, TEventMap, TDerives, E>) => boolean,
		handler: Middleware<ResolveEventCtx<TOut, TEventMap, TDerives, E>>,
	): this;

	// Existing 2-arg with optional Patch generic
	on<E extends keyof TEventMap & string, Patch extends object = {}>(
		event: MaybeArray<E>,
		handler: Middleware<ResolveEventCtx<TOut, TEventMap, TDerives, E> & Patch>,
	): this;

	use<Patch extends object>(handler: Middleware<TOut & Patch>): this;
	use(...middleware: Middleware<TOut>[]): this;

	// Gate with type predicate → narrow TOut for downstream handlers
	guard<Narrowing>(
		predicate: (context: any) => context is Narrowing,
	): EventComposer<TBase, TEventMap, TIn, TOut & Narrowing, TExposed, TDerives, TMethods, TMacros> & TMethods;

	// Boolean predicate or with middleware → no narrowing
	guard<S extends TOut>(
		predicate: ((context: TOut) => context is S) | ((context: TOut) => boolean | Promise<boolean>),
		...middleware: Middleware<any>[]
	): this;

	branch(
		predicate: ((context: TOut) => boolean | Promise<boolean>) | boolean,
		onTrue: Middleware<TOut>,
		onFalse?: Middleware<TOut>,
	): this;

	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		cases: Partial<Record<K, (composer: Composer<TOut, TOut, {}>) => Composer<any, any, any>>>,
		fallback?: (composer: Composer<TOut, TOut, {}>) => Composer<any, any, any>,
	): this;
	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		builder: (route: RouteBuilder<TOut, K>) => void,
	): this;
	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		cases: Partial<Record<K, Middleware<TOut> | Middleware<TOut>[] | Composer<any, any, any>>>,
		fallback?: Middleware<TOut> | Middleware<TOut>[] | Composer<any, any, any>,
	): this;

	fork(
		...middleware: Middleware<TOut>[]
	): this;

	tap(
		...middleware: Middleware<TOut>[]
	): this;

	lazy(
		factory: LazyFactory<TOut>,
	): this;

	onError(
		handler: ErrorHandler<TOut>,
	): this;

	error(
		kind: string,
		errorClass: { new (...args: any): any; prototype: Error },
	): this;

	group(
		fn: (composer: Composer<TOut, TOut, {}>) => void,
	): this;

	// --- Methods that change generics → propagate TMethods via 7th generic ---

	decorate<D extends object>(
		values: D,
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed, TDerives, TMethods, TMacros> & TMethods;
	decorate<D extends object>(
		values: D,
		options: { as: "scoped" | "global" },
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed & D, TDerives, TMethods, TMacros> & TMethods;

	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed, TDerives, TMethods, TMacros> & TMethods;
	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
		options: { as: "scoped" | "global" },
	): EventComposer<TBase, TEventMap, TIn, TOut & D, TExposed & D, TDerives, TMethods, TMacros> & TMethods;
	// Event-specific derive — adds to TDerives[E], NOT to global TOut
	derive<E extends keyof TEventMap & string, D extends object>(
		event: MaybeArray<E>,
		handler: DeriveHandler<ResolveEventCtx<TOut, TEventMap, TDerives, E>, D>,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives & { [K in E]: D }, TMethods, TMacros> & TMethods;

	when<UOut extends TOut>(
		condition: boolean,
		fn: (composer: Composer<TOut, TOut, {}>) => Composer<TOut, UOut, any>,
	): EventComposer<TBase, TEventMap, TIn, TOut & Partial<Omit<UOut, keyof TOut>>, TExposed, TDerives, TMethods, TMacros> & TMethods;

	as(
		scope: "scoped" | "global",
	): EventComposer<TBase, TEventMap, TIn, TOut, TOut, TDerives, TMethods, TMacros> & TMethods;

	// Extend another EventComposer — merges TDerives and TMacros
	extend<UIn extends TBase, UOut extends UIn, UExposed extends object, UDerives extends Record<string, object>, UMacros extends MacroDefinitions = {}>(
		other: EventComposer<TBase, TEventMap, UIn, UOut, UExposed, UDerives, any, UMacros>,
	): EventComposer<TBase, TEventMap, TIn, TOut & UExposed, TExposed, TDerives & UDerives, TMethods, TMacros & UMacros> & TMethods;

	// Extend plain Composer — merges TMacros, TDerives unchanged
	extend<UIn extends object, UOut extends UIn, UExposed extends object, UMacros extends MacroDefinitions = {}>(
		other: Composer<UIn, UOut, UExposed, UMacros>,
	): EventComposer<TBase, TEventMap, TIn, TOut & UExposed, TExposed, TDerives, TMethods, TMacros & UMacros> & TMethods;

	// ─── Macro Methods ───

	/** Register a single named macro */
	macro<const Name extends string, TDef extends MacroDef<any, any>>(
		name: Name,
		definition: TDef,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives, TMethods, TMacros & Record<Name, TDef>> & TMethods;

	/** Register multiple macros at once */
	macro<const TDefs extends Record<string, MacroDef<any, any>>>(
		definitions: TDefs,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives, TMethods, TMacros & TDefs> & TMethods;

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
		macros: Record<string, MacroDef<any, any>>;
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
		TMacros extends MacroDefinitions = {},
	>(
		options?: ComposerOptions,
	): EventComposer<TBase, TEventMap, TIn, TOut, TExposed, TDerives, TMethods, TMacros> & TMethods;
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
	methods?: TMethods & ThisType<EventComposer<TBase, TEventMap, TBase, TBase, {}, {}, TMethods> & TMethods>;
}): {
	Composer: EventComposerConstructor<TBase, TEventMap, TMethods>;
	compose: typeof compose;
	EventQueue: typeof EventQueue;
} {
	class EventComposerImpl extends Composer<any, any, any, any> {
		on(
			eventOrFilter: string | string[] | ((ctx: any) => boolean),
			filterOrHandler: Middleware<any> | ((ctx: any) => boolean),
			handler?: Middleware<any>,
		) {
			// Filter-only mode: first arg is a function
			if (typeof eventOrFilter === "function") {
				const filter = eventOrFilter as (ctx: any) => boolean;
				const actualHandler = filterOrHandler as Middleware<any>;
				const filterLabel = filter.name || "filter";
				const mw: Middleware<any> = (ctx: any, next: any) => {
					if (filter(ctx)) return actualHandler(ctx, next);
					return next();
				};
				nameMiddleware(mw, "on", filterLabel);
				this["~"].middlewares.push({ fn: mw, scope: "local", type: "on", name: filterLabel });
				this.invalidate();
				return this;
			}

			// Event-based mode (existing logic)
			const events = Array.isArray(eventOrFilter) ? eventOrFilter : [eventOrFilter];
			const eventLabel = events.join("|");

			const actualHandler = handler ?? (filterOrHandler as Middleware<any>);
			const filter = handler ? (filterOrHandler as (ctx: any) => boolean) : undefined;

			const mw: Middleware<any> = (ctx: any, next: any) => {
				if (!events.includes(config.discriminator(ctx))) return next();
				if (filter && !filter(ctx)) return next();
				return actualHandler(ctx, next);
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
