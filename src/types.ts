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
export type MaybeArray<T> = T | T[];

/** Scope level for middleware propagation */
export type Scope = "local" | "scoped" | "global";

/** Which method created a middleware entry */
export type MiddlewareType =
	| "use" | "derive" | "decorate" | "guard" | "branch"
	| "route" | "fork" | "tap" | "lazy" | "group" | "extend" | "on";

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
