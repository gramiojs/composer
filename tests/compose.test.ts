import { describe, expect, it } from "bun:test";
import { compose } from "../src/compose.ts";
import type { Middleware } from "../src/types.ts";

describe("compose()", () => {
	it("empty array — returns pass-through middleware", async () => {
		const fn = compose([]);
		let nextCalled = false;
		await fn({}, () => {
			nextCalled = true;
			return Promise.resolve();
		});
		expect(nextCalled).toBe(true);
	});

	it("empty array — resolves without next", async () => {
		const fn = compose([]);
		await fn({});
	});

	it("single middleware — works correctly", async () => {
		const calls: string[] = [];
		const mw: Middleware<{}> = (_, next) => {
			calls.push("mw");
			return next();
		};
		const fn = compose([mw]);
		await fn({});
		expect(calls).toEqual(["mw"]);
	});

	it("multiple middleware — runs in order (onion model)", async () => {
		const calls: string[] = [];

		const mw1: Middleware<{}> = async (_, next) => {
			calls.push("1-before");
			await next();
			calls.push("1-after");
		};
		const mw2: Middleware<{}> = async (_, next) => {
			calls.push("2-before");
			await next();
			calls.push("2-after");
		};
		const mw3: Middleware<{}> = async (_, next) => {
			calls.push("3-before");
			await next();
			calls.push("3-after");
		};

		const fn = compose([mw1, mw2, mw3]);
		await fn({});

		expect(calls).toEqual([
			"1-before",
			"2-before",
			"3-before",
			"3-after",
			"2-after",
			"1-after",
		]);
	});

	it("next() called multiple times — throws", async () => {
		const mw: Middleware<{}> = async (_, next) => {
			await next();
			await next();
		};

		const fn = compose([mw]);
		expect(fn({})).rejects.toThrow("next() called multiple times");
	});

	it("sync throw — converted to rejection", async () => {
		const mw: Middleware<{}> = () => {
			throw new Error("sync error");
		};

		const fn = compose([mw]);
		expect(fn({})).rejects.toThrow("sync error");
	});

	it("async rejection — propagated", async () => {
		const mw: Middleware<{}> = async () => {
			throw new Error("async error");
		};

		const fn = compose([mw]);
		expect(fn({})).rejects.toThrow("async error");
	});

	it("error in nested middleware — propagates up", async () => {
		const mw1: Middleware<{}> = async (_, next) => {
			await next();
		};
		const mw2: Middleware<{}> = async () => {
			throw new Error("deep error");
		};

		const fn = compose([mw1, mw2]);
		expect(fn({})).rejects.toThrow("deep error");
	});

	it("terminal continuation — called when all middleware exhausted", async () => {
		let terminalCalled = false;
		const mw: Middleware<{}> = (_, next) => next();

		const fn = compose([mw]);
		await fn({}, () => {
			terminalCalled = true;
			return Promise.resolve();
		});

		expect(terminalCalled).toBe(true);
	});

	it("context is shared across middleware", async () => {
		const ctx = { value: 0 };

		const mw1: Middleware<{ value: number }> = (ctx, next) => {
			ctx.value = 1;
			return next();
		};
		const mw2: Middleware<{ value: number }> = (ctx, next) => {
			ctx.value = 2;
			return next();
		};

		const fn = compose([mw1, mw2]);
		await fn(ctx);

		expect(ctx.value).toBe(2);
	});

	it("middleware can short-circuit by not calling next()", async () => {
		const calls: string[] = [];

		const mw1: Middleware<{}> = async (_, next) => {
			calls.push("1");
			await next();
		};
		const mw2: Middleware<{}> = async () => {
			calls.push("2-stop");
			// does not call next()
		};
		const mw3: Middleware<{}> = async (_, next) => {
			calls.push("3");
			await next();
		};

		const fn = compose([mw1, mw2, mw3]);
		await fn({});

		expect(calls).toEqual(["1", "2-stop"]);
	});
});
