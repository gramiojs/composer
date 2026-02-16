import { compose } from "./compose.ts";
import { noopNext } from "./utils.ts";
import type {
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
	/** @internal */
	_middlewares: ScopedMiddleware<any>[] = [];
	/** @internal */
	_extended = new Set<string>();
	/** @internal */
	_compiled: Middleware<TIn> | null = null;

	readonly name: string | undefined;
	readonly seed: unknown;

	constructor(options?: ComposerOptions) {
		this.name = options?.name;
		this.seed = options?.seed;
	}

	/** @internal */
	invalidate(): void {
		this._compiled = null;
	}

	// ─── Middleware Methods ───

	use(
		...middleware: Middleware<TOut>[]
	): Composer<TIn, TOut, TExposed> {
		for (const fn of middleware) {
			this._middlewares.push({ fn, scope: "local" });
		}
		this.invalidate();
		return this;
	}

	derive<D extends object>(
		handler: DeriveHandler<TOut, D>,
		options?: { as: "scoped" | "global" },
	): Composer<TIn, TOut & D, TExposed & (typeof options extends { as: string } ? D : {})> {
		const mw: Middleware<any> = async (ctx, next) => {
			const result = await handler(ctx);
			Object.assign(ctx, result);
			return next();
		};
		const scope: Scope = options?.as ?? "local";
		this._middlewares.push({ fn: mw, scope });
		this.invalidate();
		return this as any;
	}

	filter<S extends TOut>(
		predicate: ((context: TOut) => context is S) | ((context: TOut) => boolean | Promise<boolean>),
		...middleware: Middleware<any>[]
	): Composer<TIn, TOut, TExposed> {
		const chain = compose(middleware);
		const mw: Middleware<any> = async (ctx, next) => {
			if (await predicate(ctx)) {
				await chain(ctx, next);
			} else {
				await next();
			}
		};
		this._middlewares.push({ fn: mw, scope: "local" });
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
				this._middlewares.push({ fn: onTrue as Middleware<any>, scope: "local" });
			} else if (onFalse) {
				this._middlewares.push({ fn: onFalse as Middleware<any>, scope: "local" });
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
		this._middlewares.push({ fn: mw, scope: "local" });
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
		this._middlewares.push({ fn: mw, scope: "local" });
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
		this._middlewares.push({ fn: mw, scope: "local" });
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
		this._middlewares.push({ fn: mw, scope: "local" });
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
		this._middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	onError(
		handler: ErrorHandler<TOut>,
	): Composer<TIn, TOut, TExposed> {
		// Wrap all SUBSEQUENT middleware in try/catch.
		// We do this by capturing the current length — when building,
		// subsequent middleware will be wrapped.
		const boundaryIndex = this._middlewares.length;

		const mw: Middleware<any> = async (ctx, next) => {
			try {
				return await next();
			} catch (error) {
				return handler(ctx, error);
			}
		};
		this._middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	// ─── Scope System ───

	as(scope: "scoped" | "global"): Composer<TIn, TOut, TOut> {
		for (const entry of this._middlewares) {
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

		const chain = compose(group._middlewares.map((m) => m.fn));
		const mw: Middleware<any> = async (ctx, next) => {
			const scopedCtx = Object.create(ctx);
			await chain(scopedCtx, noopNext);
			return next();
		};
		this._middlewares.push({ fn: mw, scope: "local" });
		this.invalidate();
		return this;
	}

	extend<UIn extends object, UOut extends UIn, UExposed extends object>(
		other: Composer<UIn, UOut, UExposed>,
	): Composer<TIn, TOut & UExposed, TExposed> {
		// 1. Dedup check
		if (other.name) {
			const key = `${other.name}:${JSON.stringify(other.seed ?? null)}`;
			if (this._extended.has(key)) return this as any;
			this._extended.add(key);
		}

		// 2. Inherit other's extended set (transitive dedup)
		for (const key of other._extended) {
			this._extended.add(key);
		}

		// 3. Process other's middleware by scope
		const localMws = other._middlewares.filter((m) => m.scope === "local");
		const scopedMws = other._middlewares.filter((m) => m.scope === "scoped");
		const globalMws = other._middlewares.filter((m) => m.scope === "global");

		// Local → wrap in isolated group
		if (localMws.length > 0) {
			const chain = compose(localMws.map((m) => m.fn));
			const isolated: Middleware<any> = async (ctx, next) => {
				const scopedCtx = Object.create(ctx);
				await chain(scopedCtx, noopNext);
				return next();
			};
			this._middlewares.push({ fn: isolated, scope: "local" });
		}

		// Scoped → add as LOCAL in parent (stops here)
		for (const mw of scopedMws) {
			this._middlewares.push({ fn: mw.fn, scope: "local" });
		}

		// Global → add as GLOBAL in parent (continues propagating)
		for (const mw of globalMws) {
			this._middlewares.push({ fn: mw.fn, scope: "global" });
		}

		this.invalidate();
		return this as any;
	}

	compose(): Middleware<TIn> {
		if (!this._compiled) {
			this._compiled = compose(
				this._middlewares.map((m) => m.fn),
			) as Middleware<TIn>;
		}
		return this._compiled;
	}

	run(context: TIn, next?: Next): Promise<void> {
		return this.compose()(context, next ?? noopNext) as Promise<void>;
	}
}
