import { describe, expect, it } from "bun:test";
import { createComposer } from "../src/factory.ts";

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
