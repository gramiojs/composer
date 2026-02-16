import { describe, expect, it } from "bun:test";
import { Composer } from "../src/composer.ts";

describe("Scope system", () => {
	// ─── as() ───

	describe("as()", () => {
		it("promotes all middleware to scoped", () => {
			const plugin = new Composer()
				.use((_, next) => next())
				.derive(() => ({ a: 1 }))
				.as("scoped");

			for (const entry of plugin["~"].middlewares) {
				expect(entry.scope).toBe("scoped");
			}
		});

		it("promotes all middleware to global", () => {
			const plugin = new Composer()
				.use((_, next) => next())
				.derive(() => ({ a: 1 }))
				.as("global");

			for (const entry of plugin["~"].middlewares) {
				expect(entry.scope).toBe("global");
			}
		});
	});

	// ─── extend() with scopes ───

	describe("extend() — local scope (default)", () => {
		it("local middleware is isolated — derives don't leak", async () => {
			const plugin = new Composer()
				.derive(() => ({ secret: 42 }))
				.use((ctx, next) => {
					expect(ctx.secret).toBe(42);
					return next();
				});

			let parentSaw: unknown;
			const app = new Composer()
				.extend(plugin)
				.use((ctx, next) => {
					parentSaw = ctx.secret;
					return next();
				});

			await app.run({});
			expect(parentSaw).toBeUndefined();
		});
	});

	describe("extend() — scoped", () => {
		it("scoped middleware propagates one level", async () => {
			const plugin = new Composer()
				.derive(() => ({ user: "alice" }))
				.as("scoped");

			let parentSaw: unknown;
			const app = new Composer()
				.extend(plugin)
				.use((ctx, next) => {
					parentSaw = (ctx as any).user;
					return next();
				});

			await app.run({});
			expect(parentSaw).toBe("alice");
		});

		it("scoped does NOT propagate to grandparent", async () => {
			const inner = new Composer({ name: "inner" })
				.derive(() => ({ a: 1 }))
				.as("scoped");

			const middle = new Composer({ name: "middle" }).extend(inner);

			let outerSaw: unknown;
			const outer = new Composer()
				.extend(middle)
				.use((ctx, next) => {
					outerSaw = (ctx as any).a;
					return next();
				});

			await outer.run({});
			expect(outerSaw).toBeUndefined();
		});
	});

	describe("extend() — global", () => {
		it("global middleware propagates to all ancestors", async () => {
			const inner = new Composer({ name: "inner-global" })
				.derive(() => ({ g: "global" }))
				.as("global");

			const middle = new Composer({ name: "middle" }).extend(inner);

			let outerSaw: unknown;
			const outer = new Composer()
				.extend(middle)
				.use((ctx, next) => {
					outerSaw = (ctx as any).g;
					return next();
				});

			await outer.run({});
			expect(outerSaw).toBe("global");
		});

		it("global propagates through multiple levels", async () => {
			const deep = new Composer({ name: "deep" })
				.derive(() => ({ deep: true }))
				.as("global");

			const level2 = new Composer({ name: "level2" }).extend(deep);
			const level1 = new Composer({ name: "level1" }).extend(level2);

			let topSaw: unknown;
			const top = new Composer()
				.extend(level1)
				.use((ctx, next) => {
					topSaw = (ctx as any).deep;
					return next();
				});

			await top.run({});
			expect(topSaw).toBe(true);
		});
	});

	describe("scope promotion: scoped doesn't demote global", () => {
		it("as('scoped') does not demote global entries", () => {
			const plugin = new Composer()
				.derive(() => ({ a: 1 }));

			// Manually set first to global
			plugin["~"].middlewares[0].scope = "global";

			plugin.as("scoped");

			// global should remain global, not be demoted
			expect(plugin["~"].middlewares[0].scope).toBe("global");
		});
	});
});
