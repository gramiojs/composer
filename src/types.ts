/** next() continuation function */
export type Next = () => Promise<unknown>;

/** Middleware function: receives context and next */
export type Middleware<T> = (context: T, next: Next) => unknown;

/** Composed middleware: next is optional (acts as terminal continuation) */
export type ComposedMiddleware<T> = (context: T, next?: Next) => Promise<unknown>;

/** Error handler receives an object with error, context, and resolved kind */
export type ErrorHandler<T> = (params: {
	error: unknown;
	context: T;
	kind?: string;
}) => unknown;

/** Function that computes additional context properties */
export type DeriveHandler<T, D> = (context: T) => D | Promise<D>;

/** Lazy middleware factory — called per invocation */
export type LazyFactory<T> = (context: T) => Middleware<T> | Promise<Middleware<T>>;

/** Single value or array */
export type MaybeArray<T> = T | readonly T[];

/** Scope level for middleware propagation */
export type Scope = "local" | "scoped" | "global";

/** Which method created a middleware entry */
export type MiddlewareType =
	| "use" | "derive" | "decorate" | "guard" | "branch"
	| "route" | "fork" | "tap" | "lazy" | "group" | "extend" | "on" | "macro";

// ─── Macro System Types ─────────────────────────────────────────────────────

/** Brand symbol for ContextCallback marker type */
declare const ContextCallbackBrand: unique symbol;

/**
 * Marker type for context-aware callbacks in macro options.
 * The framework replaces this with the actual handler context type at the call site.
 *
 * @example
 * ```ts
 * interface ThrottleOptions {
 *   limit: number;
 *   onLimit?: ContextCallback;  // ← framework substitutes the real ctx type
 * }
 * ```
 */
export interface ContextCallback {
	readonly [ContextCallbackBrand]: true;
	(ctx: never): unknown;
}

/**
 * Recursively replaces all `ContextCallback` occurrences in `T`
 * with `(ctx: TCtx) => unknown`.
 */
export type WithCtx<T, TCtx> =
	T extends ContextCallback
		? (ctx: TCtx) => unknown
		: T extends (...args: any[]) => any
			? T   // don't recurse into regular functions
			: T extends object
				? { [K in keyof T]: WithCtx<T[K], TCtx> }
				: T;

/** What a macro can return when activated */
export interface MacroHooks<TDerive extends object = {}> {
	/** Middleware to run before the main handler */
	preHandler?: Middleware<any> | Middleware<any>[];
	/**
	 * Context enrichment — return type gets merged into the handler's context.
	 * Return `void` / `undefined` to stop the middleware chain (acts as a guard).
	 */
	derive?: (ctx: any) => TDerive | void | Promise<TDerive | void>;
}

/**
 * A macro definition: either a function accepting options, or a plain hooks object (boolean shorthand).
 *
 * @example
 * ```ts
 * // Parameterized macro
 * const throttle: MacroDef<{ limit: number }, {}> = (opts) => ({
 *   preHandler: createThrottleMiddleware(opts),
 * });
 *
 * // Boolean shorthand
 * const onlyAdmin: MacroDef<void, {}> = {
 *   preHandler: checkAdminMiddleware,
 * };
 * ```
 */
export type MacroDef<TOptions = void, TDerive extends object = {}> =
	| ((opts: TOptions) => MacroHooks<TDerive>)
	| MacroHooks<TDerive>;

/** Registry of named macro definitions */
export type MacroDefinitions = Record<string, MacroDef<any, any>>;

/** Extract the options type a macro accepts (boolean for shorthand macros) */
export type MacroOptionType<M> =
	M extends (opts: infer O) => any ? O : boolean;

/** Extract the derive (context enrichment) type from a macro */
export type MacroDeriveType<M> =
	M extends (opts: any) => { derive: (...a: any) => infer R }
		? Exclude<Awaited<R>, void>
		: M extends { derive: (...a: any) => infer R }
			? Exclude<Awaited<R>, void>
			: {};

/**
 * Builds the `options` parameter type for handler methods.
 * Includes `preHandler` plus all registered macro option types
 * with ContextCallback markers replaced by `TBaseCtx`.
 */
export type HandlerOptions<TBaseCtx, Macros extends MacroDefinitions> =
	{ preHandler?: Middleware<TBaseCtx> | Middleware<TBaseCtx>[] }
	& { [K in keyof Macros]?: WithCtx<MacroOptionType<Macros[K]>, TBaseCtx> };

/** Helper: converts a union to an intersection */
type UnionToIntersection<U> =
	(U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/**
 * Collects all derive types from macros that are activated in `TOptions`.
 * The result is intersected into the handler's context type.
 */
export type DeriveFromOptions<Macros extends MacroDefinitions, TOptions> =
	UnionToIntersection<{
		[K in keyof TOptions & keyof Macros]: MacroDeriveType<Macros[K]>
	}[keyof TOptions & keyof Macros]>;

/** Read-only projection of a middleware entry for inspect()/trace() */
export interface MiddlewareInfo {
	index: number;
	type: MiddlewareType;
	name?: string;
	scope: Scope;
	plugin?: string;
}

/** Trace callback invoked on middleware enter; returns cleanup called on exit */
export type TraceHandler = (
	entry: MiddlewareInfo,
	context: any,
) => ((error?: unknown) => void) | void;

/** Internal middleware entry with scope annotation and metadata */
export interface ScopedMiddleware<T> {
	fn: Middleware<T>;
	scope: Scope;
	type: MiddlewareType;
	name?: string;
	plugin?: string;
}

/** Composer constructor options */
export interface ComposerOptions {
	name?: string;
	seed?: unknown;
}
