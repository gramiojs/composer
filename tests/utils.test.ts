import { describe, expect, it } from "bun:test";
import { noopNext, skip, stop } from "../src/utils.ts";

describe("Utilities", () => {
	it("noopNext resolves immediately", async () => {
		const result = await noopNext();
		expect(result).toBeUndefined();
	});

	it("skip — calls next()", async () => {
		let nextCalled = false;
		await skip({}, () => {
			nextCalled = true;
			return Promise.resolve();
		});
		expect(nextCalled).toBe(true);
	});

	it("stop — does NOT call next()", async () => {
		let nextCalled = false;
		await stop({}, () => {
			nextCalled = true;
			return Promise.resolve();
		});
		expect(nextCalled).toBe(false);
	});
});
