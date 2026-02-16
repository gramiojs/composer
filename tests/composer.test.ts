import { describe, expect, it } from "bun:test";
import { Composer } from "../src/composer.ts";
import { noopNext } from "../src/utils.ts";

describe("Composer", () => {
	// ─── use() ───

	describe("use()", () => {
		it("registers middleware and runs in order", async () => {
			const calls: number[] = [];
			const app = new Composer()
				.use((_, next) => {
					calls.push(1);
					return next();
				})
				.use((_, next) => {
					calls.push(2);
					return next();
				});

			await app.run({});
			expect(calls).toEqual([1, 2]);
		});

		it("accepts multiple middleware at once", async () => {
			const calls: number[] = [];
			const app = new Composer().use(
				(_, next) => {
					calls.push(1);
					return next();
				},
				(_, next) => {
					calls.push(2);
					return next();
				},
			);

			await app.run({});
			expect(calls).toEqual([1, 2]);
		});
	});

	// ─── derive() ───

	describe("derive()", () => {
		it("adds properties to context", async () => {
			let derivedValue: number | undefined;

			const app = new Composer<{ base: string }>()
				.derive((ctx) => ({ extra: ctx.base.length }))
				.use((ctx, next) => {
					derivedValue = (ctx as any).extra;
					return next();
				});

			await app.run({ base: "hello" });
			expect(derivedValue).toBe(5);
		});

		it("async derive works", async () => {
			let derivedValue: string | undefined;

			const app = new Composer()
				.derive(async () => {
					await Promise.resolve();
					return { async: "value" };
				})
				.use((ctx, next) => {
					derivedValue = (ctx as any).async;
					return next();
				});

			await app.run({});
			expect(derivedValue).toBe("value");
		});

		it("multiple derives accumulate", async () => {
			let a: number | undefined;
			let b: string | undefined;

			const app = new Composer()
				.derive(() => ({ a: 1 }))
				.derive(() => ({ b: "two" }))
				.use((ctx, next) => {
					a = (ctx as any).a;
					b = (ctx as any).b;
					return next();
				});

			await app.run({});
			expect(a).toBe(1);
			expect(b).toBe("two");
		});

		it("derive calls next()", async () => {
			const calls: string[] = [];

			const app = new Composer()
				.use((_, next) => {
					calls.push("before");
					return next();
				})
				.derive(() => ({ x: 1 }))
				.use((_, next) => {
					calls.push("after");
					return next();
				});

			await app.run({});
			expect(calls).toEqual(["before", "after"]);
		});
	});

	// ─── guard() ───

	describe("guard()", () => {
		it("runs middleware only when predicate is true", async () => {
			const calls: string[] = [];

			const app = new Composer<{ pass: boolean }>().guard(
				(ctx) => ctx.pass,
				(_, next) => {
					calls.push("filtered");
					return next();
				},
			);

			await app.run({ pass: true });
			expect(calls).toEqual(["filtered"]);

			calls.length = 0;
			await app.run({ pass: false });
			expect(calls).toEqual([]);
		});

		it("calls next() when predicate is false", async () => {
			let afterCalled = false;

			const app = new Composer<{ pass: boolean }>()
				.guard(
					(ctx) => ctx.pass,
					() => {},
				)
				.use((_, next) => {
					afterCalled = true;
					return next();
				});

			await app.run({ pass: false });
			expect(afterCalled).toBe(true);
		});

		it("always calls next() after filtered middleware (can't block chain)", async () => {
			const calls: string[] = [];

			const app = new Composer<{ pass: boolean }>()
				.guard(
					(ctx) => ctx.pass,
					() => {
						calls.push("filtered");
						// does NOT call next — but chain should continue anyway
					},
				)
				.use((_, next) => {
					calls.push("after");
					return next();
				});

			await app.run({ pass: true });
			expect(calls).toEqual(["filtered", "after"]);
		});

		it("async predicate works", async () => {
			const calls: string[] = [];

			const app = new Composer<{ pass: boolean }>().guard(
				async (ctx) => ctx.pass,
				(_, next) => {
					calls.push("filtered");
					return next();
				},
			);

			await app.run({ pass: true });
			expect(calls).toEqual(["filtered"]);
		});

		// ─── Guard mode (no handlers) ───

		it("guard: no handlers + true → continues chain", async () => {
			const calls: string[] = [];

			const app = new Composer<{ pass: boolean }>()
				.guard((ctx) => ctx.pass)
				.use((_, next) => {
					calls.push("after");
					return next();
				});

			await app.run({ pass: true });
			expect(calls).toEqual(["after"]);
		});

		it("guard: no handlers + false → stops chain", async () => {
			const calls: string[] = [];

			const app = new Composer<{ pass: boolean }>()
				.guard((ctx) => ctx.pass)
				.use((_, next) => {
					calls.push("after");
					return next();
				});

			await app.run({ pass: false });
			expect(calls).toEqual([]);
		});

		it("guard: stops this composer but parent continues", async () => {
			const calls: string[] = [];

			// Inner composer with guard — stops when false
			const guarded = new Composer<{ role: string }>()
				.guard((ctx) => ctx.role === "admin")
				.use((_, next) => {
					calls.push("admin-only");
					return next();
				});

			// Parent continues after the guarded child
			const app = new Composer<{ role: string }>()
				.extend(guarded)
				.use((_, next) => {
					calls.push("always");
					return next();
				});

			// Admin passes guard
			await app.run({ role: "admin" });
			expect(calls).toEqual(["admin-only", "always"]);

			calls.length = 0;

			// Non-admin blocked by guard, but parent continues
			await app.run({ role: "user" });
			expect(calls).toEqual(["always"]);
		});
	});

	// ─── branch() ───

	describe("branch()", () => {
		it("runs onTrue when predicate returns true", async () => {
			const calls: string[] = [];

			const app = new Composer<{ flag: boolean }>().branch(
				(ctx) => ctx.flag,
				(_, next) => {
					calls.push("true");
					return next();
				},
				(_, next) => {
					calls.push("false");
					return next();
				},
			);

			await app.run({ flag: true });
			expect(calls).toEqual(["true"]);
		});

		it("runs onFalse when predicate returns false", async () => {
			const calls: string[] = [];

			const app = new Composer<{ flag: boolean }>().branch(
				(ctx) => ctx.flag,
				(_, next) => {
					calls.push("true");
					return next();
				},
				(_, next) => {
					calls.push("false");
					return next();
				},
			);

			await app.run({ flag: false });
			expect(calls).toEqual(["false"]);
		});

		it("calls next() when predicate false and no onFalse", async () => {
			let nextCalled = false;

			const app = new Composer<{ flag: boolean }>()
				.branch(
					(ctx) => ctx.flag,
					() => {},
				)
				.use((_, next) => {
					nextCalled = true;
					return next();
				});

			await app.run({ flag: false });
			expect(nextCalled).toBe(true);
		});

		it("static boolean true — registers onTrue at registration time", async () => {
			const calls: string[] = [];

			const app = new Composer().branch(
				true,
				(_, next) => {
					calls.push("true");
					return next();
				},
				(_, next) => {
					calls.push("false");
					return next();
				},
			);

			await app.run({});
			expect(calls).toEqual(["true"]);
		});

		it("static boolean false — registers onFalse at registration time", async () => {
			const calls: string[] = [];

			const app = new Composer().branch(
				false,
				(_, next) => {
					calls.push("true");
					return next();
				},
				(_, next) => {
					calls.push("false");
					return next();
				},
			);

			await app.run({});
			expect(calls).toEqual(["false"]);
		});

		it("static false with no onFalse — does nothing", async () => {
			const calls: string[] = [];

			const app = new Composer()
				.branch(false, () => {
					calls.push("true");
				})
				.use((_, next) => {
					calls.push("after");
					return next();
				});

			await app.run({});
			expect(calls).toEqual(["after"]);
		});
	});

	// ─── route() ───

	describe("route()", () => {
		it("dispatches to correct case", async () => {
			const calls: string[] = [];

			const app = new Composer<{ type: string }>().route(
				(ctx) => ctx.type,
				{
					a: (_, next) => {
						calls.push("a");
						return next();
					},
					b: (_, next) => {
						calls.push("b");
						return next();
					},
				},
			);

			await app.run({ type: "a" });
			expect(calls).toEqual(["a"]);

			calls.length = 0;
			await app.run({ type: "b" });
			expect(calls).toEqual(["b"]);
		});

		it("calls fallback when no case matches", async () => {
			const calls: string[] = [];

			const app = new Composer<{ type: string }>().route(
				(ctx) => ctx.type,
				{
					a: (_, next) => {
						calls.push("a");
						return next();
					},
				},
				(_, next) => {
					calls.push("fallback");
					return next();
				},
			);

			await app.run({ type: "unknown" });
			expect(calls).toEqual(["fallback"]);
		});

		it("calls next() when no case and no fallback", async () => {
			let nextCalled = false;

			const app = new Composer<{ type: string }>()
				.route((ctx) => ctx.type, {})
				.use((_, next) => {
					nextCalled = true;
					return next();
				});

			await app.run({ type: "any" });
			expect(nextCalled).toBe(true);
		});
	});

	// ─── fork() ───

	describe("fork()", () => {
		it("runs in parallel and doesn't block chain", async () => {
			const calls: string[] = [];

			const app = new Composer()
				.fork(async () => {
					await new Promise((r) => setTimeout(r, 50));
					calls.push("forked");
				})
				.use((_, next) => {
					calls.push("main");
					return next();
				});

			await app.run({});
			// Main should run before forked completes
			expect(calls).toEqual(["main"]);

			// Wait for fork to complete
			await new Promise((r) => setTimeout(r, 100));
			expect(calls).toEqual(["main", "forked"]);
		});

		it("errors in fork don't affect main chain", async () => {
			const calls: string[] = [];

			const app = new Composer()
				.fork(() => {
					throw new Error("fork error");
				})
				.use((_, next) => {
					calls.push("main");
					return next();
				});

			await app.run({});
			expect(calls).toEqual(["main"]);
		});
	});

	// ─── tap() ───

	describe("tap()", () => {
		it("runs middleware but always continues chain", async () => {
			const calls: string[] = [];

			const app = new Composer()
				.tap((ctx) => {
					calls.push("tapped");
					// does NOT call next — but chain continues anyway
				})
				.use((_, next) => {
					calls.push("after");
					return next();
				});

			await app.run({});
			expect(calls).toEqual(["tapped", "after"]);
		});

		it("tap middleware receives context", async () => {
			let value: string | undefined;

			const app = new Composer<{ msg: string }>().tap((ctx) => {
				value = ctx.msg;
			});

			await app.run({ msg: "hello" });
			expect(value).toBe("hello");
		});
	});

	// ─── lazy() ───

	describe("lazy()", () => {
		it("factory called per invocation", async () => {
			let factoryCalls = 0;

			const app = new Composer().lazy(() => {
				factoryCalls++;
				return (_, next) => next();
			});

			await app.run({});
			await app.run({});
			await app.run({});

			expect(factoryCalls).toBe(3);
		});

		it("runs the returned middleware", async () => {
			const calls: string[] = [];

			const app = new Composer<{ route: string }>().lazy((ctx) => {
				if (ctx.route === "a") {
					return (_, next) => {
						calls.push("route-a");
						return next();
					};
				}
				return (_, next) => {
					calls.push("default");
					return next();
				};
			});

			await app.run({ route: "a" });
			expect(calls).toEqual(["route-a"]);

			calls.length = 0;
			await app.run({ route: "b" });
			expect(calls).toEqual(["default"]);
		});
	});

	// ─── onError() ───

	describe("onError()", () => {
		it("catches errors from middleware", async () => {
			let caughtError: unknown;

			const app = new Composer()
				.onError(({ error }) => {
					caughtError = error;
					return true; // handled
				})
				.use(() => {
					throw new Error("test error");
				});

			await app.run({});
			expect(caughtError).toBeInstanceOf(Error);
			expect((caughtError as Error).message).toBe("test error");
		});

		it("multiple handlers — first to return non-undefined wins", async () => {
			const order: string[] = [];

			const app = new Composer()
				.onError(({ error }) => {
					order.push("logger");
					// return undefined → pass to next handler
				})
				.onError(({ error }) => {
					order.push("handler");
					return true; // handled
				})
				.onError(() => {
					order.push("never");
					return true;
				})
				.use(() => {
					throw new Error("oops");
				});

			await app.run({});
			expect(order).toEqual(["logger", "handler"]);
		});

		it("default logs to console.error if no handler returns", async () => {
			const originalError = console.error;
			let logged = false;
			console.error = () => { logged = true; };

			try {
				const app = new Composer()
					.use(() => {
						throw new Error("unhandled");
					});

				await app.run({});
				expect(logged).toBe(true);
			} finally {
				console.error = originalError;
			}
		});

		it("does not re-throw — process stays alive", async () => {
			const originalError = console.error;
			console.error = () => {};

			try {
				const app = new Composer()
					.use(() => {
						throw new Error("should not crash");
					});

				// Should resolve, not reject
				await app.run({});
			} finally {
				console.error = originalError;
			}
		});

		it("resolves error kind from registered error classes", async () => {
			class NotFoundError extends Error {
				constructor(message = "not found") {
					super(message);
				}
			}

			let resolvedKind: string | undefined;

			const app = new Composer()
				.error("NotFound", NotFoundError)
				.onError(({ kind }) => {
					resolvedKind = kind;
					return true;
				})
				.use(() => {
					throw new NotFoundError();
				});

			await app.run({});
			expect(resolvedKind).toBe("NotFound");
		});

		it("kind is undefined for unregistered errors", async () => {
			let resolvedKind: string | undefined = "should-be-undefined";

			const app = new Composer()
				.error("NotFound", class extends Error {})
				.onError(({ kind }) => {
					resolvedKind = kind;
					return true;
				})
				.use(() => {
					throw new Error("unknown");
				});

			await app.run({});
			expect(resolvedKind).toBeUndefined();
		});

		it("handlers from extended plugins are merged", async () => {
			class PluginError extends Error {}
			let caughtKind: string | undefined;

			const plugin = new Composer({ name: "err-plugin" })
				.error("Plugin", PluginError)
				.onError(({ kind }) => {
					caughtKind = kind;
					return true;
				});

			const app = new Composer()
				.extend(plugin)
				.use(() => {
					throw new PluginError();
				});

			await app.run({});
			expect(caughtKind).toBe("Plugin");
		});
	});

	// ─── group() ───

	describe("group()", () => {
		it("middleware isolated from parent", async () => {
			const ctx = { value: "original" } as any;

			const app = new Composer<{ value: string }>()
				.group((g) => {
					g.derive(() => ({ extra: "inner" })).use((ctx, next) => {
						expect((ctx as any).extra).toBe("inner");
						return next();
					});
				})
				.use((ctx, next) => {
					// extra should NOT leak
					expect((ctx as any).extra).toBeUndefined();
					return next();
				});

			await app.run(ctx);
		});

		it("parent properties visible inside group (prototype chain)", async () => {
			let visible: string | undefined;

			const app = new Composer<{ from: string }>().group((g) => {
				g.use((ctx, next) => {
					visible = ctx.from;
					return next();
				});
			});

			await app.run({ from: "parent" });
			expect(visible).toBe("parent");
		});

		it("group derives don't leak to parent", async () => {
			const ctx = {} as any;

			const app = new Composer()
				.group((g) => {
					g.derive(() => ({ leaked: true }));
				})
				.use((ctx, next) => {
					expect((ctx as any).leaked).toBeUndefined();
					return next();
				});

			await app.run(ctx);
		});
	});

	// ─── compose() and run() ───

	describe("compose() / run()", () => {
		it("lazy compilation — caches result", () => {
			const app = new Composer().use((_, next) => next());
			const fn1 = app.compose();
			const fn2 = app.compose();
			expect(fn1).toBe(fn2);
		});

		it("dirty flag — invalidates cache on use()", () => {
			const app = new Composer().use((_, next) => next());
			const fn1 = app.compose();
			app.use((_, next) => next());
			const fn2 = app.compose();
			expect(fn1).not.toBe(fn2);
		});

		it("run() is shorthand for compose()(ctx)", async () => {
			const calls: string[] = [];
			const app = new Composer().use((_, next) => {
				calls.push("ran");
				return next();
			});

			await app.run({});
			expect(calls).toEqual(["ran"]);
		});
	});
});
