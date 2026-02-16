import type { Middleware, Next } from "./types.ts";

/** Sets fn.name so stack traces show `type:handlerName` instead of `anonymous` */
export function nameMiddleware<T extends Function>(fn: T, type: string, handlerName?: string): T {
	Object.defineProperty(fn, "name", {
		value: handlerName ? `${type}:${handlerName}` : type,
		configurable: true,
	});
	return fn;
}

/** No-op next function: () => Promise.resolve() */
export const noopNext: Next = () => Promise.resolve();

/** Pass-through middleware: calls next() immediately */
export const skip: Middleware<any> = (_, next) => next();

/** Terminal middleware: does NOT call next() */
export const stop: Middleware<any> = () => {};
