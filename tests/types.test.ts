import { describe, it, expectTypeOf } from "bun:test";
import { Composer, createComposer, compose } from "../src/index.ts";
import type {
	Middleware,
	ComposedMiddleware,
	Next,
	ErrorHandler,
	DeriveHandler,
	MaybeArray,
	Scope,
} from "../src/index.ts";

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
		type Expected = (context: { a: number }, error: unknown) => unknown;
		expectTypeOf<ErrorHandler<{ a: number }>>().toEqualTypeOf<Expected>();
	});

	it("DeriveHandler returns D or Promise<D>", () => {
		type Handler = DeriveHandler<{ a: number }, { b: string }>;
		expectTypeOf<Handler>().toEqualTypeOf<
			(context: { a: number }) => { b: string } | Promise<{ b: string }>
		>();
	});

	it("MaybeArray<T> is T | T[]", () => {
		expectTypeOf<MaybeArray<string>>().toEqualTypeOf<string | string[]>();
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
		expectTypeOf(c).toEqualTypeOf<Composer<{ a: number }, { a: number }, {}>>();
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
});
