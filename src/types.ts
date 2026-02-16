/** next() continuation function */
export type Next = () => Promise<unknown>;

/** Middleware function: receives context and next */
export type Middleware<T> = (context: T, next: Next) => unknown;

/** Error handler receives context and the caught error */
export type ErrorHandler<T> = (context: T, error: unknown) => unknown;

/** Function that computes additional context properties */
export type DeriveHandler<T, D> = (context: T) => D | Promise<D>;

/** Lazy middleware factory — called per invocation */
export type LazyFactory<T> = (context: T) => Middleware<T> | Promise<Middleware<T>>;

/** Single value or array */
export type MaybeArray<T> = T | T[];

/** Scope level for middleware propagation */
export type Scope = "local" | "scoped" | "global";

/** Internal middleware entry with scope annotation */
export interface ScopedMiddleware<T> {
	fn: Middleware<T>;
	scope: Scope;
}

/** Composer constructor options */
export interface ComposerOptions {
	name?: string;
	seed?: unknown;
}
