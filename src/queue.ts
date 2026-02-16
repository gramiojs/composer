/**
 * Concurrent event queue with graceful shutdown support.
 * Processes events in parallel (like an event loop), not sequentially.
 */
export class EventQueue<T> {
	private handler: (event: T) => Promise<unknown>;
	private queue: T[] = [];
	private pendingUpdates = new Set<Promise<unknown>>();
	private active = true;
	private idleResolvers: (() => void)[] = [];

	constructor(handler: (event: T) => Promise<unknown>) {
		this.handler = handler;
	}

	add(event: T): void {
		this.queue.push(event);
		this.process();
	}

	addBatch(events: T[]): void {
		this.queue.push(...events);
		this.process();
	}

	async stop(timeout = 3000): Promise<void> {
		this.active = false;

		// Wait for idle or timeout
		await Promise.race([
			this.onIdle(),
			new Promise<void>((resolve) => setTimeout(resolve, timeout)),
		]);
	}

	onIdle(): Promise<void> {
		if (this.queue.length === 0 && this.pendingUpdates.size === 0) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.idleResolvers.push(resolve);
		});
	}

	get pending(): number {
		return this.pendingUpdates.size;
	}

	get queued(): number {
		return this.queue.length;
	}

	get isActive(): boolean {
		return this.active;
	}

	private process(): void {
		while (this.queue.length > 0 && this.active) {
			const event = this.queue.shift()!;
			const promise = this.handler(event)
				.catch(() => {})
				.then(() => {
					this.pendingUpdates.delete(promise);
					this.checkIdle();
				});
			this.pendingUpdates.add(promise);
		}
	}

	private checkIdle(): void {
		if (this.queue.length === 0 && this.pendingUpdates.size === 0) {
			for (const resolve of this.idleResolvers) {
				resolve();
			}
			this.idleResolvers = [];
		}
	}
}
