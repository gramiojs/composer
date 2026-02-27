import { describe, it, expectTypeOf } from "bun:test";
import { Composer, createComposer, compose, defineComposerMethods } from "../src/index.ts";
import type {
	Middleware,
	ComposedMiddleware,
	Next,
	ErrorHandler,
	DeriveHandler,
	MaybeArray,
	Scope,
	ContextOf,
	ComposerLike,
} from "../src/index.ts";
import { eventTypes } from "../src/index.ts";

// ─── Core type definitions ───

describe("Type definitions", () => {
	it("Next is () => Promise<unknown>", () => {
		expectTypeOf<Next>().toEqualTypeOf<() => Promise<unknown>>();
	});

	it("Middleware<T> is (context: T, next: Next) => unknown", () => {
		type Expected = (context: { a: number }, next: Next) => unknown;
		expectTypeOf<Middleware<{ a: number }>>().toEqualTypeOf<Expected>();
	});

	it("ErrorHandler<T> receives context and error", () => {
		type Expected = (params: {error: unknown, context: { a: number }}) => unknown;
		expectTypeOf<ErrorHandler<{ a: number }>>().toExtend<Expected>();
	});

	it("DeriveHandler returns D or Promise<D>", () => {
		type Handler = DeriveHandler<{ a: number }, { b: string }>;
		expectTypeOf<Handler>().toEqualTypeOf<
			(context: { a: number }) => { b: string } | Promise<{ b: string }>
		>();
	});

	it("MaybeArray<T> is T | readonly T[]", () => {
		expectTypeOf<MaybeArray<string>>().toEqualTypeOf<string | readonly string[]>();
	});

	it("Scope is union of string literals", () => {
		expectTypeOf<Scope>().toEqualTypeOf<"local" | "scoped" | "global">();
	});
});

// ─── compose() types ───

describe("compose() types", () => {
	it("returns ComposedMiddleware<T> from Middleware<T>[]", () => {
		const mws: Middleware<{ x: number }>[] = [];
		const result = compose(mws);
		expectTypeOf(result).toEqualTypeOf<ComposedMiddleware<{ x: number }>>();
	});
});

// ─── Composer type accumulation ───

describe("Composer type accumulation", () => {
	it("use() preserves types", () => {
		const c = new Composer<{ a: number }>().use((ctx, next) => {
			expectTypeOf(ctx).toEqualTypeOf<{ a: number }>();
			return next();
		});
		expectTypeOf(c).toEqualTypeOf<Composer<{ a: number }, { a: number }, {}, {}>>();
	});

	it("use<Patch>() extends context with Patch without changing TOut", () => {
		new Composer<{ a: number }>().use<{ extra: string }>((ctx, next) => {
			expectTypeOf(ctx.a).toBeNumber();
			expectTypeOf(ctx.extra).toBeString();
			return next();
		});
	});

	it("derive() grows TOut", () => {
		const c = new Composer<{ a: number }>().derive(() => ({ b: "hello" }));

		// After derive, the composer's TOut grows by { b: string }
		// Subsequent middleware sees the merged type
		c.use((ctx, next) => {
			expectTypeOf(ctx).toEqualTypeOf<{ a: number } & { b: string }>();
			return next();
		});
	});

	it("chained derives accumulate", () => {
		new Composer<{ a: number }>()
			.derive(() => ({ b: "str" }))
			.derive(() => ({ c: true }))
			.use((ctx, next) => {
				expectTypeOf(ctx).toEqualTypeOf<
					{ a: number } & { b: string } & { c: boolean }
				>();
				return next();
			});
	});

	it("derive with scope grows TExposed", () => {
		const c = new Composer<{ a: number }>().derive(
			() => ({ b: "str" }),
			{ as: "scoped" },
		);

		// TExposed should include { b: string }
		type Exposed = typeof c extends Composer<any, any, infer E> ? E : never;
		expectTypeOf<Exposed>().toMatchTypeOf<{ b: string }>();
	});

	it("as('scoped') sets TExposed = TOut", () => {
		const c = new Composer<{ a: number }>()
			.derive(() => ({ b: "str" }))
			.as("scoped");

		type Out = typeof c extends Composer<any, infer O, any> ? O : never;
		type Exposed = typeof c extends Composer<any, any, infer E> ? E : never;
		expectTypeOf<Exposed>().toEqualTypeOf<Out>();
	});

	it("extend() merges UExposed into parent TOut", () => {
		const plugin = new Composer<{}>()
			.derive(() => ({ user: "alice" }))
			.as("scoped");

		new Composer<{}>()
			.extend(plugin)
			.use((ctx, next) => {
				expectTypeOf(ctx).toMatchTypeOf<{ user: string }>();
				return next();
			});
	});

	it("extend() local plugin does NOT expose types", () => {
		const plugin = new Composer<{}>().derive(() => ({ secret: 42 }));
		// plugin TExposed = {} (local)

		type PluginExposed = typeof plugin extends Composer<any, any, infer E>
			? E
			: never;
		expectTypeOf<PluginExposed>().toEqualTypeOf<{}>();
	});

	it("compose() returns ComposedMiddleware<TIn>", () => {
		const c = new Composer<{ req: string }>()
			.derive(() => ({ extra: 1 }))
			.use((_, next) => next());

		const handler = c.compose();
		expectTypeOf(handler).toEqualTypeOf<ComposedMiddleware<{ req: string }>>();
	});

	it("run() accepts TIn context", () => {
		const c = new Composer<{ req: string }>().derive(() => ({ x: 1 }));

		// run() should accept { req: string }, not { req: string } & { x: 1 }
		expectTypeOf<Parameters<typeof c.run>[0]>().toEqualTypeOf<{ req: string }>();
	});
});

// ─── createComposer / EventComposer types ───

describe("EventComposer types", () => {
	interface Base {
		updateType: string;
	}
	interface MsgCtx extends Base {
		text?: string;
	}
	interface CbCtx extends Base {
		data?: string;
	}

	const { Composer: EC } = createComposer<
		Base,
		{ message: MsgCtx; callback_query: CbCtx }
	>({
		discriminator: (ctx) => ctx.updateType,
	});

	it(".on() narrows context to event type + derives", () => {
		new EC()
			.derive(() => ({ ts: 0 }))
			.on("message", (ctx, next) => {
				expectTypeOf(ctx).toMatchTypeOf<{ text?: string; ts: number }>();
				return next();
			});
	});

	it(".on() with multiple events creates union", () => {
		new EC().on(["message", "callback_query"], (ctx, next) => {
			expectTypeOf(ctx).toMatchTypeOf<Base & (MsgCtx | CbCtx)>();
			return next();
		});
	});

	// ─── Per-event derive types ───

	it("derive(event, handler) — per-event derive visible only in matching .on()", () => {
		const app = new EC()
			.derive("message", () => ({ parsed: "hello" }));

		// .on("message") sees the per-event derive
		app.on("message", (ctx, next) => {
			expectTypeOf(ctx).toMatchTypeOf<{ text?: string; parsed: string }>();
			return next();
		});

		// .on("callback_query") does NOT see message-specific derive
		app.on("callback_query", (ctx, next) => {
			expectTypeOf(ctx).toMatchTypeOf<{ data?: string }>();
			// @ts-expect-error — parsed is NOT on callback_query context
			ctx.parsed;
			return next();
		});
	});

	it("derive(event) accumulates per-event derives", () => {
		new EC()
			.derive("message", () => ({ a: 1 }))
			.derive("message", () => ({ b: "two" }))
			.on("message", (ctx, next) => {
				expectTypeOf(ctx).toMatchTypeOf<{ a: number; b: string; text?: string }>();
				return next();
			});
	});

	it("global derive + per-event derive both visible in .on()", () => {
		new EC()
			.derive(() => ({ global: true }))
			.derive("message", () => ({ perEvent: 42 }))
			.on("message", (ctx, next) => {
				expectTypeOf(ctx).toMatchTypeOf<{ global: boolean; perEvent: number; text?: string }>();
				return next();
			});
	});

	it("per-event derive does NOT pollute global TOut (.use())", () => {
		const app = new EC()
			.derive("message", () => ({ messageOnly: true }));

		// .use() sees TOut which should NOT include per-event derives
		app.use((ctx, next) => {
			// @ts-expect-error — messageOnly is per-event, not global
			ctx.messageOnly;
			return next();
		});
	});

	it("extend() merges per-event derives from another EventComposer", () => {
		const plugin = new EC({ name: "msg-plugin" })
			.derive("message", () => ({ fromPlugin: "yes" }))
			.as("scoped");

		new EC()
			.extend(plugin)
			.on("message", (ctx, next) => {
				expectTypeOf(ctx).toMatchTypeOf<{ fromPlugin: string; text?: string }>();
				return next();
			});
	});

	it("Derives phantom type accessible via ['~']['Derives']", () => {
		const app = new EC()
			.derive("message", () => ({ x: 1 }))
			.derive("callback_query", () => ({ y: "str" }));

		type D = typeof app["~"]["Derives"];
		expectTypeOf<D>().toMatchTypeOf<{ message: { x: number }; callback_query: { y: string } }>();
	});
});

// ─── decorate() types ───

describe("decorate() types", () => {
	it("decorate() grows TOut", () => {
		const c = new Composer<{ a: number }>().decorate({ b: "hello" });

		c.use((ctx, next) => {
			expectTypeOf(ctx).toEqualTypeOf<{ a: number } & { b: string }>();
			return next();
		});
	});

	it("chained decorates accumulate", () => {
		new Composer<{ a: number }>()
			.decorate({ b: "str" })
			.decorate({ c: true })
			.use((ctx, next) => {
				expectTypeOf(ctx).toEqualTypeOf<
					{ a: number } & { b: string } & { c: boolean }
				>();
				return next();
			});
	});

	it("decorate with scope grows TExposed", () => {
		const c = new Composer<{ a: number }>().decorate(
			{ b: "str" },
			{ as: "scoped" },
		);

		type Exposed = typeof c extends Composer<any, any, infer E> ? E : never;
		expectTypeOf<Exposed>().toMatchTypeOf<{ b: string }>();
	});

	it("decorate without scope does NOT grow TExposed", () => {
		const c = new Composer<{ a: number }>().decorate({ b: "str" });

		type Exposed = typeof c extends Composer<any, any, infer E> ? E : never;
		expectTypeOf<Exposed>().toEqualTypeOf<{}>();
	});

	it("decorate + derive interleave correctly", () => {
		new Composer<{ a: number }>()
			.decorate({ b: "static" })
			.derive(() => ({ c: true }))
			.use((ctx, next) => {
				expectTypeOf(ctx).toEqualTypeOf<
					{ a: number } & { b: string } & { c: boolean }
				>();
				return next();
			});
	});
});

// ─── when() types ───

describe("when() types", () => {
	it("when() adds Partial types for derived properties", () => {
		new Composer<{ a: number }>()
			.when(true, (c) => c.derive(() => ({ extra: 42 })))
			.use((ctx, next) => {
				expectTypeOf(ctx).toEqualTypeOf<
					{ a: number } & Partial<{ extra: number }>
				>();
				return next();
			});
	});

	it("when() adds Partial types for decorated properties", () => {
		new Composer<{ a: number }>()
			.when(true, (c) => c.decorate({ flag: "on" }))
			.use((ctx, next) => {
				expectTypeOf(ctx).toEqualTypeOf<
					{ a: number } & Partial<{ flag: string }>
				>();
				return next();
			});
	});

	it("when() does NOT affect TExposed", () => {
		const c = new Composer<{ a: number }>()
			.when(true, (c) => c.derive(() => ({ extra: 42 })));

		type Exposed = typeof c extends Composer<any, any, infer E> ? E : never;
		expectTypeOf<Exposed>().toEqualTypeOf<{}>();
	});

	it("when(false) produces same types as when(true)", () => {
		const a = new Composer<{ x: number }>()
			.when(true, (c) => c.derive(() => ({ y: "str" })));
		const b = new Composer<{ x: number }>()
			.when(false, (c) => c.derive(() => ({ y: "str" })));

		type AOut = typeof a extends Composer<any, infer O, any> ? O : never;
		type BOut = typeof b extends Composer<any, infer O, any> ? O : never;
		expectTypeOf<AOut>().toEqualTypeOf<BOut>();
	});

	it("when() preserves existing types untouched", () => {
		new Composer<{ a: number }>()
			.derive(() => ({ b: "existing" }))
			.when(true, (c) => c.derive(() => ({ c: true })))
			.use((ctx, next) => {
				// a and b are required, c is optional
				expectTypeOf(ctx.a).toEqualTypeOf<number>();
				expectTypeOf(ctx.b).toEqualTypeOf<string>();
				return next();
			});
	});
});

// ─── .on() filter overloads types ───

describe(".on() 3-arg filter overloads types", () => {
	interface Base {
		updateType: string;
	}
	interface MsgCtx extends Base {
		text?: string;
		caption?: string;
	}
	interface CbCtx extends Base {
		data?: string;
	}

	const { Composer: EC } = createComposer<
		Base,
		{ message: MsgCtx; callback_query: CbCtx }
	>({
		discriminator: (ctx) => ctx.updateType,
	});

	it("type-narrowing filter narrows context in handler", () => {
		new EC().on(
			"message",
			(ctx): ctx is MsgCtx & { text: string } => ctx.text !== undefined,
			(ctx, next) => {
				expectTypeOf(ctx.text).toBeString();
				// original MsgCtx properties still present
				expectTypeOf(ctx.caption).toEqualTypeOf<string | undefined>();
				return next();
			},
		);
	});

	it("boolean filter preserves full context in handler (no narrowing)", () => {
		new EC().on(
			"message",
			(ctx) => ctx.text !== undefined,
			(ctx, next) => {
				// text stays optional — no narrowing with boolean filter
				expectTypeOf(ctx.text).toEqualTypeOf<string | undefined>();
				return next();
			},
		);
	});

	it("type-narrowing filter with derives — both visible in handler", () => {
		new EC()
			.derive(() => ({ ts: 0 }))
			.on(
				"message",
				(ctx): ctx is MsgCtx & { text: string } => ctx.text !== undefined,
				(ctx, next) => {
					expectTypeOf(ctx.text).toBeString();
					expectTypeOf(ctx.ts).toBeNumber();
					return next();
				},
			);
	});

	it("Patch generic on 2-arg .on() extends context", () => {
		new EC().on<"message", { args: string }>("message", (ctx, next) => {
			expectTypeOf(ctx.args).toBeString();
			expectTypeOf(ctx.text).toEqualTypeOf<string | undefined>();
			return next();
		});
	});

	it("Patch generic on .use() extends context", () => {
		new EC().use<{ args: string }>((ctx, next) => {
			expectTypeOf(ctx.args).toBeString();
			expectTypeOf(ctx.updateType).toBeString();
			return next();
		});
	});
});

// ─── guard() type narrowing ───

describe("guard() type narrowing", () => {
	interface Base {
		updateType: string;
	}
	interface MsgCtx extends Base {
		text?: string;
	}
	interface CbCtx extends Base {
		data?: string;
	}

	const { Composer: EC } = createComposer<
		Base,
		{ message: MsgCtx; callback_query: CbCtx }
	>({
		discriminator: (ctx) => ctx.updateType,
	});

	it("guard with type predicate narrows TOut for downstream .on()", () => {
		EC.prototype;
		new EC()
			.guard((ctx): ctx is Base & { text: string } => "text" in ctx)
			.on("message", (ctx, next) => {
				// text narrowed to string by guard
				expectTypeOf(ctx.text).toBeString();
				return next();
			});
	});

	it("guard with type predicate narrows TOut for downstream .use()", () => {
		new EC()
			.guard(
				(ctx): ctx is Base & { extra: number } =>
					"extra" in ctx,
			)
			.use((ctx, next) => {
				expectTypeOf(ctx.extra).toBeNumber();
				return next();
			});
	});

	it("chained guards accumulate narrowing", () => {
		new EC()
			.guard((ctx): ctx is Base & { a: number } => "a" in ctx)
			.guard((ctx): ctx is Base & { a: number } & { b: string } => "b" in ctx)
			.use((ctx, next) => {
				expectTypeOf(ctx.a).toBeNumber();
				expectTypeOf(ctx.b).toBeString();
				return next();
			});
	});

	it("guard with boolean predicate does NOT narrow (returns this)", () => {
		const app = new EC().guard((ctx) => ctx.updateType === "message");

		// TOut unchanged — still Base
		app.use((ctx, next) => {
			expectTypeOf(ctx.updateType).toBeString();
			return next();
		});
	});

	it("guard + derive + .on() — all combine", () => {
		new EC()
			.derive(() => ({ ts: 0 }))
			.guard((ctx): ctx is Base & { ts: number } & { flag: true } => true)
			.on("message", (ctx, next) => {
				expectTypeOf(ctx.ts).toBeNumber();
				expectTypeOf(ctx.flag).toEqualTypeOf<true>();
				expectTypeOf(ctx.text).toEqualTypeOf<string | undefined>();
				return next();
			});
	});
});

// ─── filter-only .on() types ───

describe(".on() filter-only overloads types", () => {
	interface Base {
		updateType: string;
	}
	interface MsgCtx extends Base {
		text?: string;
		caption?: string;
	}
	interface CbCtx extends Base {
		data?: string;
	}

	const { Composer: EC } = createComposer<
		Base,
		{ message: MsgCtx; callback_query: CbCtx }
	>({
		discriminator: (ctx) => ctx.updateType,
	});

	it("type-narrowing filter-only: handler gets narrowing intersected with compatible events", () => {
		new EC().on(
			(ctx): ctx is { text: string } => typeof (ctx as any).text === "string",
			(ctx, next) => {
				// text is narrowed to string
				expectTypeOf(ctx.text).toBeString();
				// caption from MsgCtx is still accessible (message is compatible)
				expectTypeOf(ctx.caption).toEqualTypeOf<string | undefined>();
				return next();
			},
		);
	});

	it("boolean filter-only: handler gets TOut (no narrowing)", () => {
		new EC().on(
			(ctx) => ctx.updateType === "message",
			(ctx, next) => {
				// updateType is string — no narrowing
				expectTypeOf(ctx.updateType).toBeString();
				return next();
			},
		);
	});

	it("type-narrowing filter-only with derives", () => {
		new EC()
			.derive(() => ({ ts: 0 }))
			.on(
				(ctx): ctx is { text: string } => typeof (ctx as any).text === "string",
				(ctx, next) => {
					expectTypeOf(ctx.text).toBeString();
					expectTypeOf(ctx.ts).toBeNumber();
					return next();
				},
			);
	});
});

// ─── Custom methods + derive type propagation ───

describe("Custom methods receiving derive types", () => {
	interface Base { updateType: string }
	interface MsgCtx extends Base { text?: string }
	type Map = { message: MsgCtx };

	/**
	 * Pattern 1 — Patch generic.
	 *
	 * The caller explicitly declares which derive types it needs via the Patch type arg.
	 * `ComposerLike<TThis>` constraint makes `this.on(...)` typed — no casts needed.
	 *
	 *   .command<{ user: User }>("start", (ctx) => ctx.user.id)
	 *            ^^^^^^^^^^^^^^^^ caller provides this
	 */
	it("Patch generic: caller declares extra context with <Patch> at call site", () => {
		const patchMethods = defineComposerMethods({
			command<Patch extends object = {}, TThis extends ComposerLike<TThis> = any>(
				this: TThis,
				name: string,
				handler: Middleware<MsgCtx & Patch>,
			): TThis {
				const inner: Middleware<MsgCtx & Patch> = (ctx, next) => {
					if (ctx.text === `/${name}`) return handler(ctx, next);
					return next();
				};
				return this.on("message", inner);
			},
		});

		const { Composer: EC } = createComposer<Base, Map, typeof patchMethods>({
			discriminator: (ctx) => ctx.updateType,
			types: eventTypes<Map>(),
			methods: patchMethods,
		});

		new EC()
			.derive(() => ({ user: { id: 1 } }))
			.command<{ user: { id: number } }>("start", (ctx, next) => {
				expectTypeOf(ctx.user.id).toBeNumber();   // ✅ from declared Patch
				expectTypeOf(ctx.text).toEqualTypeOf<string | undefined>(); // ✅ from MsgCtx
				return next();
			});
	});

	/**
	 * Pattern 2 — `this: TThis` + `ContextOf<TThis>`.
	 *
	 * `ComposerLike<TThis>` constraint makes `this.on(...)` return `TThis` — fully typed,
	 * no casts anywhere. Zero annotation at the call site — derives flow in automatically.
	 *
	 *   .command("start", (ctx) => ctx.user.id)
	 *                              ^^^^^^^^^ automatically typed — no annotation!
	 */
	it("ContextOf<T>: derives inferred automatically via this: TThis parameter", () => {
		const thisMethods = defineComposerMethods({
			command<TThis extends ComposerLike<TThis>>(
				this: TThis,
				name: string,
				handler: Middleware<MsgCtx & ContextOf<TThis>>,
			): TThis {
				const inner: Middleware<MsgCtx & ContextOf<TThis>> = (ctx, next) => {
					if (ctx.text === `/${name}`) return handler(ctx, next);
					return next();
				};
				return this.on("message", inner);
			},
		});

		const { Composer: EC } = createComposer<Base, Map, typeof thisMethods>({
			discriminator: (ctx) => ctx.updateType,
			types: eventTypes<Map>(),
			methods: thisMethods,
		});

		new EC()
			.derive(() => ({ user: { id: 1 } }))
			// No type arg needed — derives flow in automatically via ContextOf<TThis>:
			.command("start", (ctx, next) => {
				expectTypeOf(ctx.user.id).toBeNumber();   // ✅ inferred automatically!
				expectTypeOf(ctx.text).toEqualTypeOf<string | undefined>(); // ✅
				return next();
			});
	});

	it("ContextOf<T>: works with multiple chained derives", () => {
		const thisMethods = defineComposerMethods({
			command<TThis extends ComposerLike<TThis>>(
				this: TThis,
				name: string,
				handler: Middleware<MsgCtx & ContextOf<TThis>>,
			): TThis {
				const inner: Middleware<MsgCtx & ContextOf<TThis>> = (ctx, next) => {
					if (ctx.text === `/${name}`) return handler(ctx, next);
					return next();
				};
				return this.on("message", inner);
			},
		});

		const { Composer: EC } = createComposer<Base, Map, typeof thisMethods>({
			discriminator: (ctx) => ctx.updateType,
			types: eventTypes<Map>(),
			methods: thisMethods,
		});

		new EC()
			.derive(() => ({ user: { id: 1 } }))
			.derive(() => ({ session: { token: "abc" } }))
			.derive(() => ({ permissions: ["read"] as string[] }))
			.command("start", (ctx, next) => {
				// All three derives visible without any annotation:
				expectTypeOf(ctx.user.id).toBeNumber();
				expectTypeOf(ctx.session.token).toBeString();
				expectTypeOf(ctx.permissions).toEqualTypeOf<string[]>();
				return next();
			});
	});

	it("ContextOf<T> extracts TOut from plain Composer", () => {
		type Out1 = ContextOf<Composer<{ a: number }, { a: number; b: string }>>;
		expectTypeOf<Out1>().toEqualTypeOf<{ a: number; b: string }>();
	});

	it("ContextOf<typeof plugin> — naming a plugin's enriched context type", () => {
		interface User { id: number; name: string }

		const withUser = new Composer<{ userId: string }>()
			.derive(async (_ctx): Promise<{ user: User }> => ({
				user: { id: 1, name: "Alice" },
			}));

		type WithUser = ContextOf<typeof withUser>;

		expectTypeOf<WithUser>().toExtend<{ userId: string; user: User }>();

		// Usable as a standalone type — e.g. in a helper function signature
		const requireAdmin = (ctx: WithUser) => ctx.user.id;
		expectTypeOf(requireAdmin).toExtend<(ctx: WithUser) => number>();
	});
});
