import { compose } from "./compose.ts";
import type { MacroDef, Middleware } from "./types.ts";

/**
 * Composes a handler with macro hooks and preHandlers from an options object.
 *
 * Execution order:
 * 1. `options.preHandler` array (explicit guards — user controls order)
 * 2. Per-macro in options property order:
 *    a. macro.preHandler (guard middleware)
 *    b. macro.derive (context enrichment; void return = stop chain)
 * 3. Main handler
 */
export function buildFromOptions<TCtx>(
	macros: Record<string, MacroDef<any, any>>,
	options: Record<string, unknown> | undefined,
	handler: Middleware<TCtx>,
): Middleware<TCtx> {
	if (!options) return handler;

	const chain: Middleware<any>[] = [];

	// 1. Explicit preHandlers — always first
	const preHandler = options.preHandler;
	if (preHandler) {
		if (Array.isArray(preHandler)) {
			chain.push(...preHandler);
		} else {
			chain.push(preHandler as Middleware<any>);
		}
	}

	// 2. Process macros in options property order
	for (const key of Object.keys(options)) {
		if (key === "preHandler") continue;

		const value = options[key];
		if (value === false || value == null) continue;

		const def = macros[key];
		if (!def) continue;

		// Resolve hooks from definition
		const hooks = typeof def === "function"
			? def(value === true ? undefined : value)
			: def;

		// macro.preHandler
		if (hooks.preHandler) {
			if (Array.isArray(hooks.preHandler)) {
				chain.push(...hooks.preHandler);
			} else {
				chain.push(hooks.preHandler);
			}
		}

		// macro.derive (context enrichment; void = stop)
		if (hooks.derive) {
			const deriveFn = hooks.derive;
			chain.push(async (ctx: any, next) => {
				const derived = await deriveFn(ctx);
				if (derived == null) return; // void = stop chain
				Object.assign(ctx, derived);
				return next();
			});
		}
	}

	// 3. Main handler
	chain.push(handler as Middleware<any>);

	// Optimize: skip compose for a single middleware
	if (chain.length === 1) return chain[0] as Middleware<TCtx>;

	return compose(chain) as unknown as Middleware<TCtx>;
}
