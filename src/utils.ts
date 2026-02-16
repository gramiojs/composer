import type { Middleware, Next } from "./types.ts";

/** No-op next function: () => Promise.resolve() */
export const noopNext: Next = () => Promise.resolve();

/** Pass-through middleware: calls next() immediately */
export const skip: Middleware<any> = (_, next) => next();

/** Terminal middleware: does NOT call next() */
export const stop: Middleware<any> = () => {};
