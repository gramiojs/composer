import { compose } from "./compose.ts";
import { cleanErrorStack, nameMiddleware, noopNext } from "./utils.ts";
import type {
	ComposedMiddleware,
	ComposerOptions,
	DeriveHandler,
	ErrorHandler,
	LazyFactory,
	MacroDef,
	MacroDefinitions,
	Middleware,
	MiddlewareInfo,
	MiddlewareType,
	Next,
	Scope,
	ScopedMiddleware,
	TraceHandler,
} from "./types.ts";

/** Route handler: single middleware, array, or Composer instance */
export type RouteHandler<T extends object> =
	| Middleware<T>
	| Middleware<T>[]
	| Composer<any, any, any, any>;

/** Route builder passed to the builder-callback overload of route() */
export interface RouteBuilder<T extends object, K extends string> {
	/** Register a route. Returns a pre-typed Composer for chaining derive/use/guard etc. */
	on(key: K, ...middleware: Middleware<T>[]): Composer<T, T, {}>;
	/** Fallback when router returns undefined or key has no handler */
	otherwise(...middleware: Middleware<T>[]): void;
}

/**
 * Resolves a route handler value to a plain Middleware at registration time.
 * Errors from resolved handlers propagate to the parent (no local error wrapping).
 */
function resolveRouteHandler(handler: unknown): Middleware<any> {
	// Composer instance → compile raw chain (errors propagate to parent)
	if (handler instanceof Composer) {
		return compose(handler["~"].middlewares.map((m) => m.fn));
	}
	// Array of middleware → compose into one
	if (Array.isArray(handler)) {
		return compose(handler);
	}
	// Plain middleware function
	return handler as Middleware<any>;
}

export class Composer<
	TIn extends object = {},
	TOut extends TIn = TIn,
	TExposed extends object = {},
	TMacros extends MacroDefinitions = {},
> {
	"~" = {
		middlewares: [] as ScopedMiddleware<any>[],
		onErrors: [] as ErrorHandler<any>[],
		extended: new Set<string>(),
		compiled: null as ComposedMiddleware<any> | null,
		name: undefined as string | undefined,
		seed: undefined as unknown,
		errorsDefinitions: {} as Record<
			string,
			{ new (...args: any): any; prototype: Error }
		>,
		tracer: undefined as TraceHandler | undefined,
		macros: {} as Record<string, MacroDef<any, any>>,
		/** Phantom type accessor — never set at runtime, used by `ContextOf<T>` */
		Out: undefined as unknown as TOut,
	};

	constructor(options?: ComposerOptions) {
		this["~"].name = options?.name;
		this["~"].seed = options?.seed;
	}

	invalidate(): void {
		this["~"].compiled = null;
	}

	// ─── Macro Methods ───

	/** Register a single named macro */
	macro<const Name extends string, TDef extends MacroDef<any, any>>(
		name: Name,
		definition: TDef,
	): Composer<TIn, TOut, TExposed, TMacros & Record<Name, TDef>>;

	/** Register multiple macros at once */
	macro<const TDefs extends Record<string, MacroDef<any, any>>>(
		definitions: TDefs,
	): Composer<TIn, TOut, TExposed, TMacros & TDefs>;

	macro(
		nameOrDefs: string | Record<string, MacroDef<any, any>>,
		definition?: MacroDef<any, any>,
	): any {
		if (typeof nameOrDefs === "string") {
			this["~"].macros[nameOrDefs] = definition!;
		} else {
			Object.assign(this["~"].macros, nameOrDefs);
		}
		return this;
	}

	// ─── Middleware Methods ───

	decorate<D extends object>(
		values: D,
	): Composer<TIn, TOut & D, TExposed>;
	decorate<D extends object>(
		values: D,
		options: { as: "scoped" | "global" },
	): Composer<TIn, TOut & D, TExposed & D>;
	decorate<D extends object>(
		values: D,
		options?: { as: "scoped" | "global" },
	): Composer<TIn, TOut & D, TExposed & D> {
		const mw: Middleware<any> = (ctx, next) => {
			Object.assign(ctx, values);
			return next();
		};
		nameMiddleware(mw, "decorate");
		const scope: Scope = options?.as ?? "local";
		this["~"].middlewares.push({ fn: mw, scope, type: "decorate" });
		this.invalidate();
		return this as any;
	}

	use(handler: Middleware<TOut>): this;
	use<Patch extends object>(handler: Middleware<TOut & Patch>): this;
	use(...middleware: Middleware<TOut>[]): Composer<TIn, TOut, TExposed>;
	// biome-ignore lint/suspicious/noExplicitAny: overload implementation signature
	use(...middleware: Middleware<any>[]): this {
		for (const fn of middleware) {
			this["~"].middlewares.push({ fn, scope: "local", type: "use", name: fn.name || undefined });
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
		const handlerName = handler.name || undefined;
		const mw: Middleware<any> = async (ctx, next) => {
			const result = await handler(ctx);
			Object.assign(ctx, result);
			return next();
		};
		nameMiddleware(mw, "derive", handlerName);
		const scope: Scope = options?.as ?? "local";
		this["~"].middlewares.push({ fn: mw, scope, type: "derive", name: handlerName });
		this.invalidate();
		return this as any;
	}

	guard<S extends TOut>(
		predicate: ((context: TOut) => context is S) | ((context: TOut) => boolean | Promise<boolean>),
		...middleware: Middleware<any>[]
	): Composer<TIn, TOut, TExposed> {
		const isGate = middleware.length === 0;
		const predicateName = predicate.name || undefined;

		if (isGate) {
			const mw: Middleware<any> = async (ctx, next) => {
				if (await predicate(ctx)) return next();
			};
			nameMiddleware(mw, "guard", predicateName);
			this["~"].middlewares.push({ fn: mw, scope: "local", type: "guard", name: predicateName });
		} else {
			const chain = compose(middleware);
			const mw: Middleware<any> = async (ctx, next) => {
				if (await predicate(ctx)) {
					await chain(ctx, noopNext);
				}
				await next();
			};
			nameMiddleware(mw, "guard", predicateName);
			this["~"].middlewares.push({ fn: mw, scope: "local", type: "guard", name: predicateName });
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
			const branchName = predicate ? (onTrue.name || undefined) : (onFalse?.name || undefined);
			if (predicate) {
				this["~"].middlewares.push({ fn: onTrue as Middleware<any>, scope: "local", type: "branch", name: branchName });
			} else if (onFalse) {
				this["~"].middlewares.push({ fn: onFalse as Middleware<any>, scope: "local", type: "branch", name: branchName });
			}
			this.invalidate();
			return this;
		}

		const predicateName = predicate.name || undefined;
		const mw: Middleware<any> = async (ctx, next) => {
			if (await predicate(ctx)) {
				return onTrue(ctx, next);
			}
			return onFalse ? onFalse(ctx, next) : next();
		};
		nameMiddleware(mw, "branch", predicateName);
		this["~"].middlewares.push({ fn: mw, scope: "local", type: "branch", name: predicateName });
		this.invalidate();
		return this;
	}

	// Overload 1: builder callback — (route) => { route.on("key").derive(...).use(...) }
	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		builder: (route: RouteBuilder<TOut, K>) => void,
	): Composer<TIn, TOut, TExposed>;
	// Overload 2: handler record — Middleware, array, or Composer instance
	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		cases: Partial<Record<K, Middleware<TOut> | Middleware<TOut>[] | Composer<any, any, any>>>,
		fallback?: Middleware<TOut> | Middleware<TOut>[] | Composer<any, any, any>,
	): Composer<TIn, TOut, TExposed>;
	route<K extends string>(
		router: (context: TOut) => K | undefined | Promise<K | undefined>,
		casesOrBuilder: Partial<Record<K, unknown>> | ((route: RouteBuilder<any, any>) => void),
		fallback?: unknown,
	): Composer<TIn, TOut, TExposed> {
		let resolvedCases: Record<string, Middleware<any>>;
		let resolvedFallback: Middleware<any> | undefined;

		if (typeof casesOrBuilder === "function") {
			// Builder mode
			resolvedCases = {};
			const composers = new Map<string, Composer<any, any, any>>();
			let otherwiseMws: Middleware<any>[] = [];

			const routeBuilder: RouteBuilder<any, any> = {
				on: (key: string, ...middleware: Middleware<any>[]) => {
					const c = new Composer();
					if (middleware.length > 0) c.use(...middleware);
					composers.set(key, c);
					return c;
				},
				otherwise: (...middleware: Middleware<any>[]) => {
					otherwiseMws = middleware;
				},
			};

			casesOrBuilder(routeBuilder);

			// Compile all registered composers
			for (const [key, c] of composers) {
				resolvedCases[key] = compose(c["~"].middlewares.map((m) => m.fn));
			}
			resolvedFallback =
				otherwiseMws.length > 0 ? compose(otherwiseMws) : undefined;
		} else {
			// Record mode
			resolvedCases = {};
			for (const [key, handler] of Object.entries(casesOrBuilder)) {
				if (handler != null) {
					resolvedCases[key] = resolveRouteHandler(handler);
				}
			}
			resolvedFallback =
				fallback != null ? resolveRouteHandler(fallback) : undefined;
		}

		const routerName = router.name || undefined;
		const mw: Middleware<any> = async (ctx, next) => {
			const key = await router(ctx);
			if (key != null) {
				const caseHandler = resolvedCases[key as string];
				if (caseHandler) return caseHandler(ctx, next);
			}
			return resolvedFallback ? resolvedFallback(ctx, next) : next();
		};
		nameMiddleware(mw, "route", routerName);
		this["~"].middlewares.push({ fn: mw, scope: "local", type: "route", name: routerName });
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
		nameMiddleware(mw, "fork");
		this["~"].middlewares.push({ fn: mw, scope: "local", type: "fork" });
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
		nameMiddleware(mw, "tap");
		this["~"].middlewares.push({ fn: mw, scope: "local", type: "tap" });
		this.invalidate();
		return this;
	}

	lazy(
		factory: LazyFactory<TOut>,
	): Composer<TIn, TOut, TExposed> {
		const factoryName = factory.name || undefined;
		const mw: Middleware<any> = async (ctx, next) => {
			const resolved = await factory(ctx);
			return resolved(ctx, next);
		};
		nameMiddleware(mw, "lazy", factoryName);
		this["~"].middlewares.push({ fn: mw, scope: "local", type: "lazy", name: factoryName });
		this.invalidate();
		return this;
	}

	onError(
		handler: ErrorHandler<TOut>,
	): Composer<TIn, TOut, TExposed> {
		this["~"].onErrors.push(handler);
		this.invalidate();
		return this;
	}

	// ─── Conditional Registration ───

	when<UOut extends TOut>(
		condition: boolean,
		fn: (composer: Composer<TOut, TOut, {}>) => Composer<TOut, UOut, any>,
	): Composer<TIn, TOut & Partial<Omit<UOut, keyof TOut>>, TExposed> {
		if (condition) {
			const temp = new (this.constructor as any)();
			fn(temp);
			for (const mw of temp["~"].middlewares) {
				this["~"].middlewares.push(mw);
			}
			Object.assign(this["~"].errorsDefinitions, temp["~"].errorsDefinitions);
			this["~"].onErrors.push(...temp["~"].onErrors);
			for (const key of temp["~"].extended) {
				this["~"].extended.add(key);
			}
		}
		this.invalidate();
		return this as any;
	}

	// ─── Error Registration ───

	error(
		kind: string,
		errorClass: { new (...args: any): any; prototype: Error },
	): this {
		this["~"].errorsDefinitions[kind] = errorClass;
		return this;
	}

	// ─── Scope System ───

	as(scope: "scoped" | "global"): Composer<TIn, TOut, TOut> {
		for (const entry of this["~"].middlewares) {
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

		const chain = compose(group["~"].middlewares.map((m) => m.fn));
		const mw: Middleware<any> = async (ctx, next) => {
			const preKeys = new Set(Object.keys(ctx as object));
			const snapshot: Record<string, unknown> = {};
			for (const key of preKeys) snapshot[key] = (ctx as Record<string, unknown>)[key];
			await chain(ctx, noopNext);
			for (const key of Object.keys(ctx as object)) {
				if (!preKeys.has(key)) {
					const desc = Object.getOwnPropertyDescriptor(ctx as object, key);
					if (desc?.configurable) delete (ctx as Record<string, unknown>)[key];
				}
			}
			Object.assign(ctx as object, snapshot);
			return next();
		};
		nameMiddleware(mw, "group");
		this["~"].middlewares.push({ fn: mw, scope: "local", type: "group" });
		this.invalidate();
		return this;
	}

	extend<UIn extends object, UOut extends UIn, UExposed extends object, UMacros extends MacroDefinitions = {}>(
		other: Composer<UIn, UOut, UExposed, UMacros>,
	): Composer<TIn, TOut & UExposed, TExposed, TMacros & UMacros> {
		// 1. Dedup check
		if (other["~"].name) {
			const key = `${other["~"].name}:${JSON.stringify(other["~"].seed ?? null)}`;
			if (this["~"].extended.has(key)) return this as any;
			this["~"].extended.add(key);
		}

		// 2. Snapshot already-known keys BEFORE inheriting (for transitive dedup)
		const alreadyExtended = new Set(this["~"].extended);

		// 3. Inherit other's extended set (transitive dedup)
		for (const key of other["~"].extended) {
			this["~"].extended.add(key);
		}

		// 4. Merge error definitions, error handlers, and macros
		Object.assign(this["~"].errorsDefinitions, other["~"].errorsDefinitions);
		Object.assign(this["~"].macros, other["~"].macros);
		this["~"].onErrors.push(...other["~"].onErrors);

		// 5. Process other's middleware by scope, skipping transitively-deduped plugins
		const pluginName = other["~"].name;
		const isNew = (m: ScopedMiddleware<any>) => {
			if (!m.plugin) return true;
			for (const key of alreadyExtended) {
				if (key.startsWith(m.plugin + ":")) return false;
			}
			return true;
		};
		const localMws = other["~"].middlewares.filter((m) => m.scope === "local" && isNew(m));
		const scopedMws = other["~"].middlewares.filter((m) => m.scope === "scoped" && isNew(m));
		const globalMws = other["~"].middlewares.filter((m) => m.scope === "global" && isNew(m));

		// Local → wrap in isolated group
		if (localMws.length > 0) {
			const chain = compose(localMws.map((m) => m.fn));
			const isolated: Middleware<any> = async (ctx, next) => {
				const preKeys = new Set(Object.keys(ctx as object));
				const snapshot: Record<string, unknown> = {};
				for (const key of preKeys) snapshot[key] = (ctx as Record<string, unknown>)[key];
				await chain(ctx, noopNext);
				for (const key of Object.keys(ctx as object)) {
					if (!preKeys.has(key)) {
						const desc = Object.getOwnPropertyDescriptor(ctx as object, key);
						if (desc?.configurable) delete (ctx as Record<string, unknown>)[key];
					}
				}
				Object.assign(ctx as object, snapshot);
				return next();
			};
			nameMiddleware(isolated, "extend", pluginName);
			this["~"].middlewares.push({ fn: isolated, scope: "local", type: "extend", name: pluginName, plugin: pluginName });
		}

		// Scoped → add as LOCAL in parent (stops here)
		for (const mw of scopedMws) {
			this["~"].middlewares.push({ fn: mw.fn, scope: "local", type: mw.type, name: mw.name, plugin: mw.plugin || pluginName });
		}

		// Global → add as GLOBAL in parent (continues propagating)
		for (const mw of globalMws) {
			this["~"].middlewares.push({ fn: mw.fn, scope: "global", type: mw.type, name: mw.name, plugin: mw.plugin || pluginName });
		}

		this.invalidate();
		return this as any;
	}

	inspect(): MiddlewareInfo[] {
		return this["~"].middlewares.map((m, i) => {
			const info: MiddlewareInfo = { index: i, type: m.type, scope: m.scope };
			if (m.name) info.name = m.name;
			if (m.plugin) info.plugin = m.plugin;
			return info;
		});
	}

	trace(handler: TraceHandler): this {
		this["~"].tracer = handler;
		this.invalidate();
		return this;
	}

	compose(): ComposedMiddleware<TIn> {
		if (!this["~"].compiled) {
			const mws = this["~"].middlewares;
			const tracer = this["~"].tracer;

			const fns = tracer
				? mws.map((m, i) => {
					const info: MiddlewareInfo = { index: i, type: m.type, scope: m.scope };
					if (m.name) info.name = m.name;
					if (m.plugin) info.plugin = m.plugin;
					const orig = m.fn;
					const traced: Middleware<any> = async (ctx, next) => {
						const done = tracer(info, ctx);
						try {
							const result = await orig(ctx, next);
							done?.();
							return result;
						} catch (err) {
							done?.(err);
							throw err;
						}
					};
					nameMiddleware(traced, "traced", orig.name || m.name);
					return traced;
				})
				: mws.map((m) => m.fn);

			const chain = compose(fns);
			const onErrors = this["~"].onErrors;
			const errorsDefinitions = this["~"].errorsDefinitions;

			this["~"].compiled = (async (ctx: any, next?: Next) => {
				try {
					return await chain(ctx, next);
				} catch (error) {
					cleanErrorStack(error);
					let kind: string | undefined;
					for (const [k, ErrorClass] of Object.entries(errorsDefinitions)) {
						if (error instanceof ErrorClass) {
							kind = k;
							break;
						}
					}
					for (const handler of onErrors) {
						const result = await handler({ error, context: ctx, kind });
						if (result !== undefined) return result;
					}
					console.error("[composer] Unhandled error:", error);
				}
			}) as ComposedMiddleware<any>;
		}
		return this["~"].compiled as ComposedMiddleware<TIn>;
	}

	run(context: TIn, next?: Next): Promise<void> {
		return this.compose()(context, next ?? noopNext) as Promise<void>;
	}
}
