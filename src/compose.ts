import type { ComposedMiddleware, Middleware, Next } from "./types.ts";

/**
 * Compose an array of middleware functions into a single middleware.
 * Koa-style onion model: each middleware receives (context, next).
 */
export function compose<T>(middlewares: Middleware<T>[]): ComposedMiddleware<T> {
	// Fast path: empty array
	if (middlewares.length === 0) {
		return (_, next?) => (next ? next() : Promise.resolve());
	}

	return (context: T, next?: Next) => {
		let lastIndex = -1;

		function dispatch(i: number): Promise<unknown> {
			if (i <= lastIndex) {
				return Promise.reject(new Error("next() called multiple times"));
			}
			lastIndex = i;

			const fn = i < middlewares.length ? middlewares[i] : next;
			if (!fn) {
				return Promise.resolve();
			}

			try {
				return Promise.resolve(fn(context, () => dispatch(i + 1)));
			} catch (error) {
				return Promise.reject(error);
			}
		}

		return dispatch(0);
	};
}
