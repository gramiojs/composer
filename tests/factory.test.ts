import { describe, expect, it } from "bun:test";
import type { Middleware } from "../src/types.ts";
import { createComposer, eventTypes } from "../src/factory.ts";

interface BaseCtx {
	updateType: string;
}

interface MessageCtx extends BaseCtx {
	text?: string;
}

interface CallbackCtx extends BaseCtx {
	data?: string;
}

type EventMap = {
	message: MessageCtx;
	callback_query: CallbackCtx;
};

const { Composer } = createComposer<BaseCtx, EventMap>({
	discriminator: (ctx) => ctx.updateType,
});

describe("createComposer() / EventComposer", () => {
	it("returns configured class with .on()", () => {
		const app = new Composer();
		expect(typeof app.on).toBe("function");
	});

	it(".on() — single event", async () => {
		const calls: string[] = [];

		const app = new Composer()
			.on("message", (ctx, next) => {
				calls.push("message");
				return next();
			})
			.derive("callback_query", () => ({ timestamp: 12345 }))
			.on("callback_query", (ctx, next) => {
				calls.push("callback");
				expect(ctx.timestamp).toBe(12345);
				return next();
			});

		await app.run({ updateType: "message" });
		expect(calls).toEqual(["message"]);

		calls.length = 0;
		await app.run({ updateType: "callback_query" });
		expect(calls).toEqual(["callback"]);
	});

	it(".on() — multiple events (array)", async () => {
		const calls: string[] = [];

		const app = new Composer().on(
			["message", "callback_query"],
			(ctx, next) => {
				calls.push(ctx.updateType);
				return next();
			},
		);

		await app.run({ updateType: "message" });
		await app.run({ updateType: "callback_query" });

		expect(calls).toEqual(["message", "callback_query"]);
	});

	it(".on() — non-matching event calls next()", async () => {
		const calls: string[] = [];

		const app = new Composer()
			.on("message", (_, next) => {
				calls.push("message");
				return next();
			})
			.use((_, next) => {
				calls.push("fallthrough");
				return next();
			});

		await app.run({ updateType: "unknown" });
		expect(calls).toEqual(["fallthrough"]);
	});

	it(".on() — derives visible in handler", async () => {
		let timestamp: number | undefined;

		const app = new Composer()
			.derive(() => ({ timestamp: 12345 }))
			.on("message", (ctx, next) => {
				timestamp = (ctx as any).timestamp;
				return next();
			});

		await app.run({ updateType: "message" });
		expect(timestamp).toBe(12345);
	});

	it("EventComposer supports all base Composer methods", async () => {
		const calls: string[] = [];

		const app = new Composer()
			.use((_, next) => {
				calls.push("use");
				return next();
			})
			.derive(() => ({ d: 1 }))
			.on("message", (_, next) => {
				calls.push("on");
				return next();
			});

		await app.run({ updateType: "message" });
		expect(calls).toEqual(["use", "on"]);
	});

	it("EventComposer extend works", async () => {
		const plugin = new Composer({ name: "test-plugin" })
			.derive(() => ({ extra: "value" }))
			.as("scoped");

		let saw: unknown;
		const app = new Composer().extend(plugin).on("message", (ctx, next) => {
			saw = (ctx as any).extra;
			return next();
		});

		await app.run({ updateType: "message" });
		expect(saw).toBe("value");
	});
});

describe("createComposer() custom methods", () => {
	it("custom method is available on instances", () => {
		const { Composer } = createComposer({
			discriminator: (ctx: BaseCtx) => ctx.updateType,
			types: eventTypes<EventMap>(),
			methods: {
				hears(_trigger: RegExp | string) {
					return this;
				},
			},
		});

		const app = new Composer();
		expect(typeof app.hears).toBe("function");
	});

	it("custom method calls this.on() internally and routes correctly", async () => {
		const calls: string[] = [];

		const { Composer } = createComposer({
			discriminator: (ctx: BaseCtx) => ctx.updateType,
			types: eventTypes<EventMap>(),
			methods: {
				hears(trigger: RegExp | string, handler: Middleware<MessageCtx>) {
					return this.on("message", (context, next) => {
						const text = context.text;
						if (
							(typeof trigger === "string" && text === trigger) ||
							(trigger instanceof RegExp && text && trigger.test(text))
						) {
							return handler(context, next);
						}
						return next();
					});
				},
			},
		});

		const app = new Composer();
		app.hears("hello", (ctx, next) => {
			calls.push(`heard: ${ctx.text}`);
			return next();
		});

		await app.run({ updateType: "message", text: "hello" } as any);
		expect(calls).toEqual(["heard: hello"]);

		// Non-matching text
		calls.length = 0;
		await app.run({ updateType: "message", text: "bye" } as any);
		expect(calls).toEqual([]);

		// Non-matching event
		calls.length = 0;
		await app.run({ updateType: "callback_query" } as any);
		expect(calls).toEqual([]);
	});

	it("custom method chaining works", async () => {
		const calls: string[] = [];

		const { Composer } = createComposer({
			discriminator: (ctx: BaseCtx) => ctx.updateType,
			types: eventTypes<EventMap>(),
			methods: {
				hears(trigger: string, handler: Middleware<MessageCtx>) {
					return this.on("message", (context, next) => {
						if (context.text === trigger) {
							return handler(context, next);
						}
						return next();
					});
				},
			},
		});

		const app = new Composer();
		// Runtime chaining works — .hears() returns `this` (the composer instance).
		// Type-level: .hears() return type is EventComposer (without TMethods),
		// so subsequent .on() is typed but .hears() chain would need declaration merging.
		(app as any)
			.hears("hello", (ctx: any, next: any) => {
				calls.push("hears");
				return next();
			})
			.on("message", (ctx: any, next: any) => {
				calls.push("on:message");
				return next();
			});

		await app.run({ updateType: "message", text: "hello" } as any);
		expect(calls).toEqual(["hears", "on:message"]);
	});

	it("multiple custom methods", () => {
		const { Composer } = createComposer({
			discriminator: (ctx: BaseCtx) => ctx.updateType,
			types: eventTypes<EventMap>(),
			methods: {
				hears(_trigger: string) {
					return this;
				},
				command(_name: string) {
					return this;
				},
			},
		});

		const app = new Composer();
		expect(typeof app.hears).toBe("function");
		expect(typeof app.command).toBe("function");
	});

	it("conflict with built-in method name throws", () => {
		expect(() => {
			createComposer({
				discriminator: (ctx: BaseCtx) => ctx.updateType,
				methods: {
					on() {
						return this;
					},
				},
			});
		}).toThrow('Custom method "on" conflicts with built-in method');
	});
});
