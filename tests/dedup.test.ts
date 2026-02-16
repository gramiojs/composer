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
