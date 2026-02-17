import { describe, expect, it } from "bun:test";
import { Composer } from "../src/composer.ts";

describe("Deduplication", () => {
	it("same name — second extend is skipped", async () => {
		let callCount = 0;

		const plugin = new Composer({ name: "auth" }).use((_, next) => {
			callCount++;
			return next();
		});

		const app = new Composer().extend(plugin).extend(plugin);

		await app.run({});
		expect(callCount).toBe(1);
	});

	it("no name — always extends", async () => {
		let callCount = 0;

		const plugin = new Composer().use((_, next) => {
			callCount++;
			return next();
		});

		const app = new Composer().extend(plugin).extend(plugin);

		await app.run({});
		expect(callCount).toBe(2);
	});

	it("same name, different seed — both applied", async () => {
		let callCount = 0;

		const createPlugin = (max: number) =>
			new Composer({ name: "rate-limit", seed: { max } }).use((_, next) => {
				callCount++;
				return next();
			});

		const app = new Composer()
			.extend(createPlugin(100))
			.extend(createPlugin(200));

		await app.run({});
		expect(callCount).toBe(2);
	});

	it("same name, same seed — second skipped", async () => {
		let callCount = 0;

		const createPlugin = (max: number) =>
			new Composer({ name: "rate-limit", seed: { max } }).use((_, next) => {
				callCount++;
				return next();
			});

		const app = new Composer()
			.extend(createPlugin(100))
			.extend(createPlugin(100));

		await app.run({});
		expect(callCount).toBe(1);
	});

	it("transitive dedup — inherited through extend chain", async () => {
		let aCalls = 0;

		const pluginA = new Composer({ name: "A" }).use((_, next) => {
			aCalls++;
			return next();
		});

		const pluginB = new Composer({ name: "B" }).extend(pluginA);

		const app = new Composer()
			.extend(pluginB) // includes A
			.extend(pluginA); // should be skipped — A already came through B

		await app.run({});
		expect(aCalls).toBe(1);
	});

	it("transitive dedup — shared via two plugins, middleware runs once", async () => {
		let sharedCalls = 0;

		const shared = new Composer({ name: "shared" }).use((_, next) => {
			sharedCalls++;
			return next();
		});

		const pluginA = new Composer({ name: "pluginA" }).extend(shared);
		const pluginB = new Composer({ name: "pluginB" }).extend(shared);

		const app = new Composer()
			.extend(pluginA)  // brings shared
			.extend(pluginB); // shared already known — its middleware skipped

		await app.run({});
		expect(sharedCalls).toBe(1);
	});

	it("transitive dedup — scoped middleware from shared plugin not duplicated", async () => {
		let sharedCalls = 0;

		const shared = new Composer({ name: "shared" })
			.derive((ctx) => {
				sharedCalls++;
				return { sharedVal: 1 };
			}, { as: "scoped" });

		const pluginA = new Composer({ name: "pluginA" }).extend(shared);
		const pluginB = new Composer({ name: "pluginB" }).extend(shared);

		const app = new Composer()
			.extend(pluginA)
			.extend(pluginB);

		await app.run({});
		expect(sharedCalls).toBe(1);
	});

	it("transitive dedup — global middleware from shared plugin not duplicated", async () => {
		let sharedCalls = 0;

		const shared = new Composer({ name: "shared" })
			.derive((ctx) => {
				sharedCalls++;
				return { sharedVal: 1 };
			}, { as: "global" });

		const pluginA = new Composer({ name: "pluginA" }).extend(shared);
		const pluginB = new Composer({ name: "pluginB" }).extend(shared);

		const app = new Composer()
			.extend(pluginA)
			.extend(pluginB);

		await app.run({});
		expect(sharedCalls).toBe(1);
	});

	it("transitive dedup — diamond: A→B, A→C, B+C→D", async () => {
		let aCalls = 0;

		const a = new Composer({ name: "A" }).use((_, next) => {
			aCalls++;
			return next();
		});

		const b = new Composer({ name: "B" }).extend(a);
		const c = new Composer({ name: "C" }).extend(a);
		const d = new Composer({ name: "D" }).extend(b).extend(c);

		const app = new Composer().extend(d);
		await app.run({});
		expect(aCalls).toBe(1);
	});

	it("transitive dedup — multi-level", async () => {
		let aCalls = 0;

		const pluginA = new Composer({ name: "A" }).use((_, next) => {
			aCalls++;
			return next();
		});

		const pluginB = new Composer({ name: "B" }).extend(pluginA);
		const pluginC = new Composer({ name: "C" }).extend(pluginB);

		const app = new Composer()
			.extend(pluginC) // includes B which includes A
			.extend(pluginA); // should be skipped

		await app.run({});
		expect(aCalls).toBe(1);
	});
});
