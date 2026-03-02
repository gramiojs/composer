import { describe, expect, it } from "bun:test";
import { Composer } from "../src/composer.ts";
import { createComposer } from "../src/factory.ts";

// A minimal event-aware composer for testing
const { Composer: EventComposer } = createComposer<
	{ updateType: string },
	{ message: { updateType: string; text?: string }; callback_query: { updateType: string; data?: string }; inline_query: { updateType: string } }
>({
	discriminator: (ctx) => ctx.updateType,
});

describe("Composer.registeredEvents()", () => {
	it("returns empty set for empty base composer", () => {
		const app = new Composer();
		expect(app.registeredEvents()).toEqual(new Set());
	});

	it("does not include events from .use()", () => {
		const app = new Composer().use(() => {});
		expect(app.registeredEvents()).toEqual(new Set());
	});
});

describe("EventComposer.registeredEvents()", () => {
	it("returns empty set when no handlers registered", () => {
		const app = new EventComposer();
		expect(app.registeredEvents()).toEqual(new Set());
	});

	it("returns event from .on() with single event", () => {
		const app = new EventComposer().on("message", () => {});
		expect(app.registeredEvents()).toEqual(new Set(["message"]));
	});

	it("returns all events from .on() with array", () => {
		const app = new EventComposer().on(["message", "callback_query"], () => {});
		expect(app.registeredEvents()).toEqual(
			new Set(["message", "callback_query"]),
		);
	});

	it("deduplicates events from multiple .on() calls", () => {
		const app = new EventComposer()
			.on("message", () => {})
			.on("message", () => {});
		expect(app.registeredEvents()).toEqual(new Set(["message"]));
	});

	it("does not include events from .use()", () => {
		const app = new EventComposer().use(() => {});
		expect(app.registeredEvents()).toEqual(new Set());
	});

	it("collects events from event-specific .derive()", () => {
		const app = new EventComposer().derive("message", () => ({ extra: 1 }));
		expect(app.registeredEvents()).toEqual(new Set(["message"]));
	});

	it("does not include local events from plain extend (wrapped in 'extend' type)", () => {
		// Local middlewares are wrapped in an isolated 'extend' entry in the parent
		const child = new EventComposer().on("message", () => {});
		const parent = new EventComposer().extend(child);
		expect(parent.registeredEvents()).toEqual(new Set());
	});

	it("collects events when extending after .as('scoped') (GramIO plugin pattern)", () => {
		// GramIO promotes plugin middleware to 'scoped' before extending,
		// which preserves the original type/name in the parent's middleware list.
		const child = new EventComposer().on("message", () => {});
		const parent = new EventComposer().extend((child as any).as("scoped"));
		expect(parent.registeredEvents()).toEqual(new Set(["message"]));
	});

	it("collects events from multiple sources combined", () => {
		const app = new EventComposer()
			.on("message", () => {})
			.on("callback_query", () => {})
			.derive("inline_query", () => ({}));
		expect(app.registeredEvents()).toEqual(
			new Set(["message", "callback_query", "inline_query"]),
		);
	});
});
