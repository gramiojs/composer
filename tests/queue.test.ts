import { describe, expect, it } from "bun:test";
import { EventQueue } from "../src/queue.ts";

describe("EventQueue", () => {
	it("add() — processes event", async () => {
		const results: number[] = [];

		const queue = new EventQueue<number>(async (n) => {
			results.push(n);
		});

		queue.add(1);
		await queue.onIdle();

		expect(results).toEqual([1]);
	});

	it("addBatch() — processes all events", async () => {
		const results: number[] = [];

		const queue = new EventQueue<number>(async (n) => {
			results.push(n);
		});

		queue.addBatch([1, 2, 3]);
		await queue.onIdle();

		expect(results).toEqual([1, 2, 3]);
	});

	it("processes events concurrently", async () => {
		const order: string[] = [];

		const queue = new EventQueue<number>(async (n) => {
			if (n === 1) await new Promise((r) => setTimeout(r, 50));
			order.push(`done-${n}`);
		});

		queue.addBatch([1, 2, 3]);
		await queue.onIdle();

		// 2 and 3 should finish before 1 due to 1's delay
		expect(order.indexOf("done-2")).toBeLessThan(order.indexOf("done-1"));
		expect(order.indexOf("done-3")).toBeLessThan(order.indexOf("done-1"));
	});

	it("onIdle() — resolves when idle", async () => {
		const queue = new EventQueue<number>(async () => {});

		// Already idle
		await queue.onIdle();

		// Process something and wait
		queue.add(1);
		await queue.onIdle();
	});

	it("onIdle() — resolves immediately when no pending", async () => {
		const queue = new EventQueue<number>(async () => {});
		const start = Date.now();
		await queue.onIdle();
		expect(Date.now() - start).toBeLessThan(50);
	});

	it("pending and queued getters", async () => {
		const queue = new EventQueue<number>(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(queue.pending).toBe(0);
		expect(queue.queued).toBe(0);

		queue.add(1);

		// After add, should be processing
		expect(queue.pending).toBe(1);

		await queue.onIdle();
		expect(queue.pending).toBe(0);
	});

	it("isActive getter", async () => {
		const queue = new EventQueue<number>(async () => {});

		expect(queue.isActive).toBe(true);

		await queue.stop();
		expect(queue.isActive).toBe(false);
	});

	it("stop() — waits for pending, respects timeout", async () => {
		const results: number[] = [];

		const queue = new EventQueue<number>(async (n) => {
			await new Promise((r) => setTimeout(r, 20));
			results.push(n);
		});

		queue.addBatch([1, 2, 3]);
		await queue.stop(5000);

		expect(results).toEqual([1, 2, 3]);
		expect(queue.isActive).toBe(false);
	});

	it("stop() — forces stop on timeout", async () => {
		const queue = new EventQueue<number>(async () => {
			await new Promise((r) => setTimeout(r, 5000));
		});

		queue.add(1);

		const start = Date.now();
		await queue.stop(100);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(500);
		expect(queue.isActive).toBe(false);
	});

	it("handler errors are caught silently", async () => {
		const queue = new EventQueue<number>(async (n) => {
			if (n === 2) throw new Error("handler error");
		});

		queue.addBatch([1, 2, 3]);
		await queue.onIdle();

		// Should not throw, queue should be idle
		expect(queue.pending).toBe(0);
	});

	it("stopped queue does not process new events", async () => {
		const results: number[] = [];

		const queue = new EventQueue<number>(async (n) => {
			results.push(n);
		});

		await queue.stop();

		queue.add(1);
		// Give it a tick
		await new Promise((r) => setTimeout(r, 50));

		// Event was added to queue but not processed because isActive is false
		expect(results).toEqual([]);
	});
});
