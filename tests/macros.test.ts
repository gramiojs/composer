import { describe, expect, it } from "bun:test";
import { Composer } from "../src/composer.ts";
import { buildFromOptions } from "../src/macros.ts";
import { createComposer, eventTypes } from "../src/factory.ts";
import type { MacroDef, MacroHooks, Middleware } from "../src/types.ts";

describe("Macro System", () => {
	// ─── Composer.macro() registration ───

	describe("macro() registration", () => {
		it("registers a single named macro", () => {
			const def: MacroHooks = {
				preHandler: (_, next) => next(),
			};
			const app = new Composer().macro("auth", def);
			expect(app["~"].macros.auth).toBe(def);
		});

		it("registers multiple macros at once", () => {
			const auth: MacroHooks = { preHandler: (_, next) => next() };
			const throttle: MacroDef<{ limit: number }> = (opts) => ({
				preHandler: (_, next) => next(),
			});

			const app = new Composer().macro({ auth, throttle });
			expect(app["~"].macros.auth).toBe(auth);
			expect(app["~"].macros.throttle).toBe(throttle);
		});

		it("macros propagate via extend()", () => {
			const def: MacroHooks = { preHandler: (_, next) => next() };
			const plugin = new Composer({ name: "p" }).macro("auth", def);

			const app = new Composer().extend(plugin);
			expect(app["~"].macros.auth).toBe(def);
		});

		it("extend merges macros from multiple plugins", () => {
			const def1: MacroHooks = { preHandler: (_, next) => next() };
			const def2: MacroHooks = { preHandler: (_, next) => next() };

			const p1 = new Composer({ name: "p1" }).macro("auth", def1);
			const p2 = new Composer({ name: "p2" }).macro("cache", def2);

			const app = new Composer().extend(p1).extend(p2);
			expect(app["~"].macros.auth).toBe(def1);
			expect(app["~"].macros.cache).toBe(def2);
		});
	});

	// ─── buildFromOptions() ───

	describe("buildFromOptions()", () => {
		it("returns handler directly when no options", async () => {
			const handler: Middleware<any> = (ctx, next) => next();
			const result = buildFromOptions({}, undefined, handler);
			expect(result).toBe(handler);
		});

		it("runs options.preHandler before main handler", async () => {
			const calls: string[] = [];
			const handler: Middleware<any> = () => { calls.push("handler"); };
			const guard: Middleware<any> = (_, next) => { calls.push("guard"); return next(); };

			const composed = buildFromOptions(
				{},
				{ preHandler: guard },
				handler,
			);

			await composed({}, async () => {});
			expect(calls).toEqual(["guard", "handler"]);
		});

		it("runs options.preHandler array in order", async () => {
			const calls: string[] = [];
			const handler: Middleware<any> = () => { calls.push("handler"); };
			const g1: Middleware<any> = (_, next) => { calls.push("g1"); return next(); };
			const g2: Middleware<any> = (_, next) => { calls.push("g2"); return next(); };

			const composed = buildFromOptions(
				{},
				{ preHandler: [g1, g2] },
				handler,
			);

			await composed({}, async () => {});
			expect(calls).toEqual(["g1", "g2", "handler"]);
		});

		it("options.preHandler can stop chain", async () => {
			const calls: string[] = [];
			const handler: Middleware<any> = () => { calls.push("handler"); };
			const blocker: Middleware<any> = () => { calls.push("blocked"); };

			const composed = buildFromOptions(
				{},
				{ preHandler: blocker },
				handler,
			);

			await composed({}, async () => {});
			expect(calls).toEqual(["blocked"]);
		});

		it("runs boolean shorthand macro preHandler", async () => {
			const calls: string[] = [];
			const macros: Record<string, MacroDef<any, any>> = {
				auth: {
					preHandler: ((_: any, next: any) => { calls.push("auth"); return next(); }) as Middleware<any>,
				},
			};

			const handler: Middleware<any> = () => { calls.push("handler"); };
			const composed = buildFromOptions(macros, { auth: true }, handler);

			await composed({}, async () => {});
			expect(calls).toEqual(["auth", "handler"]);
		});

		it("skips macro when value is false", async () => {
			const calls: string[] = [];
			const macros: Record<string, MacroDef<any, any>> = {
				auth: {
					preHandler: ((_: any, next: any) => { calls.push("auth"); return next(); }) as Middleware<any>,
				},
			};

			const handler: Middleware<any> = () => { calls.push("handler"); };
			const composed = buildFromOptions(macros, { auth: false }, handler);

			await composed({}, async () => {});
			expect(calls).toEqual(["handler"]);
		});

		it("skips macro when value is null/undefined", async () => {
			const calls: string[] = [];
			const macros: Record<string, MacroDef<any, any>> = {
				auth: {
					preHandler: ((_: any, next: any) => { calls.push("auth"); return next(); }) as Middleware<any>,
				},
			};

			const handler: Middleware<any> = () => { calls.push("handler"); };
			const composed = buildFromOptions(macros, { auth: null }, handler);

			await composed({}, async () => {});
			expect(calls).toEqual(["handler"]);
		});

		it("runs parameterized macro with options", async () => {
			const calls: string[] = [];
			const macros: Record<string, MacroDef<any, any>> = {
				throttle: (opts: { limit: number }) => ({
					preHandler: ((_: any, next: any) => {
						calls.push(`throttle:${opts.limit}`);
						return next();
					}) as Middleware<any>,
				}),
			};

			const handler: Middleware<any> = () => { calls.push("handler"); };
			const composed = buildFromOptions(
				macros,
				{ throttle: { limit: 5 } },
				handler,
			);

			await composed({}, async () => {});
			expect(calls).toEqual(["throttle:5", "handler"]);
		});

		it("macro derive enriches context", async () => {
			const macros: Record<string, MacroDef<any, any>> = {
				auth: {
					derive: (ctx: any) => ({ user: { id: 1, name: "alice" } }),
				},
			};

			const handler: Middleware<any> = (ctx) => {
				expect(ctx.user).toEqual({ id: 1, name: "alice" });
			};

			const composed = buildFromOptions(macros, { auth: true }, handler);
			await composed({}, async () => {});
		});

		it("macro derive void stops chain", async () => {
			const calls: string[] = [];
			const macros: Record<string, MacroDef<any, any>> = {
				auth: {
					derive: () => { calls.push("derive"); return undefined; },
				},
			};

			const handler: Middleware<any> = () => { calls.push("handler"); };
			const composed = buildFromOptions(macros, { auth: true }, handler);

			await composed({}, async () => {});
			expect(calls).toEqual(["derive"]);
		});

		it("execution order: preHandler → macro.preHandler → macro.derive → handler", async () => {
			const calls: string[] = [];

			const macros: Record<string, MacroDef<any, any>> = {
				myMacro: {
					preHandler: ((_: any, next: any) => { calls.push("macro.preHandler"); return next(); }) as Middleware<any>,
					derive: () => { calls.push("macro.derive"); return { extra: 1 }; },
				},
			};

			const guard: Middleware<any> = (_, next) => { calls.push("preHandler"); return next(); };
			const handler: Middleware<any> = () => { calls.push("handler"); };

			const composed = buildFromOptions(
				macros,
				{ preHandler: guard, myMacro: true },
				handler,
			);

			await composed({}, async () => {});
			expect(calls).toEqual(["preHandler", "macro.preHandler", "macro.derive", "handler"]);
		});

		it("multiple macros run in property order", async () => {
			const calls: string[] = [];

			const macros: Record<string, MacroDef<any, any>> = {
				first: {
					preHandler: ((_: any, next: any) => { calls.push("first"); return next(); }) as Middleware<any>,
				},
				second: {
					preHandler: ((_: any, next: any) => { calls.push("second"); return next(); }) as Middleware<any>,
				},
			};

			const handler: Middleware<any> = () => { calls.push("handler"); };
			const composed = buildFromOptions(
				macros,
				{ first: true, second: true },
				handler,
			);

			await composed({}, async () => {});
			expect(calls).toEqual(["first", "second", "handler"]);
		});

		it("macro preHandler array works", async () => {
			const calls: string[] = [];

			const macros: Record<string, MacroDef<any, any>> = {
				multi: {
					preHandler: [
						((_, next) => { calls.push("a"); return next(); }) as Middleware<any>,
						((_, next) => { calls.push("b"); return next(); }) as Middleware<any>,
					],
				},
			};

			const handler: Middleware<any> = () => { calls.push("handler"); };
			const composed = buildFromOptions(macros, { multi: true }, handler);

			await composed({}, async () => {});
			expect(calls).toEqual(["a", "b", "handler"]);
		});

		it("ignores unknown keys in options (not registered as macros)", async () => {
			const calls: string[] = [];
			const handler: Middleware<any> = () => { calls.push("handler"); };

			const composed = buildFromOptions(
				{},
				{ unknownOption: { foo: "bar" } },
				handler,
			);

			await composed({}, async () => {});
			expect(calls).toEqual(["handler"]);
		});

		it("async derive works", async () => {
			const macros: Record<string, MacroDef<any, any>> = {
				auth: {
					derive: async () => {
						await new Promise((r) => setTimeout(r, 1));
						return { user: "bob" };
					},
				},
			};

			const handler: Middleware<any> = (ctx) => {
				expect(ctx.user).toBe("bob");
			};

			const composed = buildFromOptions(macros, { auth: true }, handler);
			await composed({}, async () => {});
		});
	});

	// ─── EventComposer macro() ───

	describe("EventComposer macro()", () => {
		const { Composer: EC } = createComposer({
			discriminator: (ctx: { type: string }) => ctx.type,
			types: eventTypes<{ message: { type: string; text?: string } }>(),
		});

		it("registers macros on EventComposer", () => {
			const def: MacroHooks = { preHandler: (_, next) => next() };
			const app = new EC().macro("auth", def);
			expect(app["~"].macros.auth).toBe(def);
		});

		it("macros propagate through EventComposer extend", () => {
			const def: MacroHooks = { preHandler: (_, next) => next() };
			const plugin = new EC({ name: "p" }).macro("auth", def);
			const app = new EC().extend(plugin);
			expect(app["~"].macros.auth).toBe(def);
		});
	});
});
