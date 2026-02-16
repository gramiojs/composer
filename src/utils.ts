import type { Middleware, Next } from "./types.ts";

/** Sets fn.name so stack traces show `type:handlerName` instead of `anonymous` */
export function nameMiddleware<T extends Function>(fn: T, type: string, handlerName?: string): T {
	Object.defineProperty(fn, "name", {
		value: handlerName ? `${type}:${handlerName}` : type,
		configurable: true,
	});
	return fn;
}

/**
 * Library source directory detected at module load time.
 * Used by cleanErrorStack to filter internal frames.
 */
const LIB_DIR = /* @__PURE__ */ (() => {
	try {
		const url = import.meta.url;
		const idx = url.lastIndexOf("/");
		let dir = url.substring(0, idx);
		if (dir.startsWith("file://")) {
			dir = dir.slice(7);
			// Windows: file:///C:/... → slice gives /C:/... → strip leading /
			if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1);
		}
		return dir;
	} catch {
		return "";
	}
})();

/** Strip library-internal frames from an error's stack trace */
export function cleanErrorStack(error: unknown): void {
	if (!LIB_DIR || !(error instanceof Error) || !error.stack) return;
	const fwd = LIB_DIR;
	const bwd = LIB_DIR.replace(/\//g, "\\");
	error.stack = error.stack
		.split("\n")
		.filter((line) => {
			if (!/^\s+at\s/.test(line)) return true;
			return !line.includes(fwd) && !line.includes(bwd);
		})
		.join("\n");
}

/** No-op next function: () => Promise.resolve() */
export const noopNext: Next = () => Promise.resolve();

/** Pass-through middleware: calls next() immediately */
export const skip: Middleware<any> = (_, next) => next();

/** Terminal middleware: does NOT call next() */
export const stop: Middleware<any> = () => {};
