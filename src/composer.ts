import { compose } from "./compose.ts";
import { noopNext } from "./utils.ts";
import type {
	ComposedMiddleware,
	ComposerOptions,
	DeriveHandler,
	ErrorHandler,
	LazyFactory,
	Middleware,
	Next,
	Scope,
	ScopedMiddleware,
} from "./types.ts";

export class Composer<
	TIn extends object = {},
	TOut extends TIn = TIn,
	TExposed extends object = {},
> {
	_ = {
		middlewares: [] as ScopedMiddleware<any>[],
		extended: new Set<string>(),
		compiled: null as ComposedMiddleware<any> | null,
		name: undefined as string | undefined,
		seed: undefined as unknown,
		errorsDefinitions: {} as Record<
			string,
			{ new (...args: any): any; prototype: Error }
		>,
	};

	"~" = this._;

	constructor(options?: ComposerOptions) {
		this._.name = options?.name;
		this._.seed = options?.seed;
	}

	invalidate(): void {
		this._.compiled = null;
	}

	// ─── Middleware Methods ───

	use(
		...middleware: Middleware<TOut>[]
	): Composer<TIn, TOut, TExposed> {
		for (const fn of middleware) {
			this._.middlewares.push({ fn, scope: "local" });
		}
		this.invalidate();
		return this;
	}

	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
	): Composer<TIn, TOut & D, TExposed>;
	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
		options: { as: "scoped" | "global" },
	): Composer<TIn, TOut & D, TExposed & D>;
	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
		options?: { as: "scoped" | "global" },
	): Composer<TIn, TOut & D, TExposed & D> {
		const mw: Middleware<any> = async (ctx, next) => {
			const result = await handler(ctx);
			Object.assign(ctx, result);
			return next();
		};
		const scope: Scope = options?.as ?? "local";
		this._.middlewares.push({ fn: mw, scope });
		this.invalidate();
		return this as any;
	}

	guard<S extends TOut>(
		predicate: ((context: TOut) => context is S) | ((context: TOut) => boolean | Promise<boolean>),
		...middleware: Middleware<any>[]
	): Composer<TIn, TOut, TExposed> {
		const isGate = middleware.length === 0;

		if (isGate) {
			// Gate mode: no handlers → gate the chain
			// true  → call next() (continue)
			// false → don't call next() (stop this chain)
			const mw: Middleware<any> = async (ctx, next) => {
				if (await predicate(ctx)) return next();
			};
			this._.middlewares.push({ fn: mw, scope: "local" });
		} else {
			// Side-effects mode: run middleware, always continue
			// true  → run handlers, then call next()
			// false → call next()
			const chain = compose(middleware);
			const mw: Middleware<any> = async (ctx, next) => {
				if (await predicate(ctx)) {
					await chain(ctx, noopNext);
				}
				await next();
			};
			this._.middlewares.push({ fn: mw, scope: "local" });
		}

		this.invalidate();
		return this;
	}

	branch(
		predicate: ((context: TOut) => boolean | Promise<boolean>) | boolean,
		onTrue: Middleware<TOut>,
		onFalse?: Middleware<TOut>,
	): Composer<TIn, TOut, TExposed> {
		// Static boolean optimization
		if (typeof predicate === "boolean") {
			if (predicate) {
				this._.middlewares.push({ fn: onTrue as Middleware<any>, scope: "local" });
			} else if (onFalse) {
				this._.middlewares.push({ fn: onFalse as Middleware<any>, scope: "local" });
			}
			this.invalidate();
			return this;
		}

		const mw: Middleware<any> = async (ctx, next) => {
			if (await predicate(ctx)) {
				return onTrue(ctx, next);
			}
			return onFalse ? onFalse(ctx, next) : next();
		};
		this._.middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	route<K extends string>(
		router: (context: TOut) => K | Promise<K>,
		cases: Partial<Record<K, Middleware<TOut>>>,
		fallback?: Middleware<TOut>,
	): Composer<TIn, TOut, TExposed> {
		const mw: Middleware<any> = async (ctx, next) => {
			const key = await router(ctx);
			const handler = (cases as Record<string, Middleware<any>>)[key];
			if (handler) {
				return handler(ctx, next);
			}
			return fallback ? fallback(ctx, next) : next();
		};
		this._.middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	fork(
		...middleware: Middleware<TOut>[]
	): Composer<TIn, TOut, TExposed> {
		const chain = compose(middleware as Middleware<any>[]);
		const mw: Middleware<any> = (ctx, next) => {
			Promise.resolve().then(() => {
				try {
					const result = chain(ctx, noopNext);
					if (result && typeof (result as any).catch === "function") {
						(result as any).catch(() => {});
					}
				} catch {
					// silently catch sync throws
				}
			});
			return next();
		};
		this._.middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	tap(
		...middleware: Middleware<TOut>[]
	): Composer<TIn, TOut, TExposed> {
		const chain = compose(middleware as Middleware<any>[]);
		const mw: Middleware<any> = async (ctx, next) => {
			await chain(ctx, noopNext);
			return next();
		};
		this._.middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	lazy(
		factory: LazyFactory<TOut>,
	): Composer<TIn, TOut, TExposed> {
		const mw: Middleware<any> = async (ctx, next) => {
			const resolved = await factory(ctx);
			return resolved(ctx, next);
		};
		this._.middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	onError(
		handler: ErrorHandler<TOut>,
	): Composer<TIn, TOut, TExposed> {
		const mw: Middleware<any> = async (ctx, next) => {
			try {
				return await next();
			} catch (error) {
				return handler(ctx, error);
			}
		};
		this._.middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	// ─── Error Registration ───

	error(
		kind: string,
		errorClass: { new (...args: any): any; prototype: Error },
	): this {
		this._.errorsDefinitions[kind] = errorClass;
		return this;
	}

	// ─── Scope System ───

	as(scope: "scoped" | "global"): Composer<TIn, TOut, TOut> {
		for (const entry of this._.middlewares) {
			if (scope === "global" || entry.scope === "local") {
				entry.scope = scope;
			}
		}
		this.invalidate();
		return this as any;
	}

	// ─── Composition Methods ───

	group(
		fn: (composer: Composer<TOut, TOut, {}>) => void,
	): Composer<TIn, TOut, TExposed> {
		const group = new Composer<TOut, TOut, {}>();
		fn(group);

		const chain = compose(group._.middlewares.map((m) => m.fn));
		const mw: Middleware<any> = async (ctx, next) => {
			const scopedCtx = Object.create(ctx);
			await chain(scopedCtx, noopNext);
			return next();
		};
		this._.middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	extend<UIn extends object, UOut extends UIn, UExposed extends object>(
		other: Composer<UIn, UOut, UExposed>,
	): Composer<TIn, TOut & UExposed, TExposed> {
		// 1. Dedup check
		if (other._.name) {
			const key = `${other._.name}:${JSON.stringify(other._.seed ?? null)}`;
			if (this._.extended.has(key)) return this as any;
			this._.extended.add(key);
		}

		// 2. Inherit other's extended set (transitive dedup)
		for (const key of other._.extended) {
			this._.extended.add(key);
		}

		// 3. Merge error definitions
		Object.assign(this._.errorsDefinitions, other._.errorsDefinitions);

		// 4. Process other's middleware by scope
		const localMws = other._.middlewares.filter((m) => m.scope === "local");
		const scopedMws = other._.middlewares.filter((m) => m.scope === "scoped");
		const globalMws = other._.middlewares.filter((m) => m.scope === "global");

		// Local → wrap in isolated group
		if (localMws.length > 0) {
			const chain = compose(localMws.map((m) => m.fn));
			const isolated: Middleware<any> = async (ctx, next) => {
				const scopedCtx = Object.create(ctx);
				await chain(scopedCtx, noopNext);
				return next();
			};
			this._.middlewares.push({ fn: isolated, scope: "local" });
		}

		// Scoped → add as LOCAL in parent (stops here)
		for (const mw of scopedMws) {
			this._.middlewares.push({ fn: mw.fn, scope: "local" });
		}

		// Global → add as GLOBAL in parent (continues propagating)
		for (const mw of globalMws) {
			this._.middlewares.push({ fn: mw.fn, scope: "global" });
		}

		this.invalidate();
		return this as any;
	}

	compose(): ComposedMiddleware<TIn> {
		if (!this._.compiled) {
			this._.compiled = compose(
				this._.middlewares.map((m) => m.fn),
			) as ComposedMiddleware<any>;
		}
		return this._.compiled as ComposedMiddleware<TIn>;
	}

	run(context: TIn, next?: Next): Promise<void> {
		return this.compose()(context, next ?? noopNext) as Promise<void>;
	}
}
