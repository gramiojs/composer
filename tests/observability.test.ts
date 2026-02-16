import { describe, expect, it } from "bun:test";
import { Composer } from "../src/composer.ts";
import { createComposer } from "../src/factory.ts";
import type { MiddlewareInfo } from "../src/types.ts";

/** Extract function names from stack frames for snapshot assertions */
function extractFrameNames(stack: string): string[] {
	return stack
		.split("\n")
		.slice(1) // skip "Error: message"
		.map((line) => line.trim())
		.filter((line) => line.startsWith("at "))
		.map((line) => {
			const match = line.match(/^at\s+([^\s(]+)/);
			return match?.[1] ?? "<unknown>";
		});
}

describe("Observability", () => {
	// ─── Function Naming ───

	describe("function naming", () => {
		it("use() does NOT rename user functions", () => {
			const app = new Composer();
			async function myHandler(_: any, next: any) {
				return next();
			}
			app.use(myHandler);
			expect(app["~"].middlewares[0].fn).toBe(myHandler);
			expect(app["~"].middlewares[0].fn.name).toBe("myHandler");
		});

		it("derive() wrapper is named derive:handlerName", () => {
			const app = new Composer();
			app.derive(function getUser() {
				return { user: "alice" };
			});
			expect(app["~"].middlewares[0].fn.name).toBe("derive:getUser");
		});

		it("derive() wrapper without handler name is named derive", () => {
			const app = new Composer();
			app.derive(() => ({ user: "alice" }));
			expect(app["~"].middlewares[0].fn.name).toBe("derive");
		});

		it("guard() wrapper is named guard:predicateName", () => {
			const app = new Composer();
			app.guard(function isAdmin() {
				return true;
			});
			expect(app["~"].middlewares[0].fn.name).toBe("guard:isAdmin");
		});

		it("branch() wrapper is named branch:predicateName", () => {
			const app = new Composer();
			app.branch(
				function isLoggedIn() {
					return true;
				},
				(_, next) => next(),
			);
			expect(app["~"].middlewares[0].fn.name).toBe("branch:isLoggedIn");
		});

		it("route() wrapper is named route:routerName", () => {
			const app = new Composer();
			app.route(
				function getRole() {
					return "admin" as const;
				},
				{ admin: (_, next) => next() },
			);
			expect(app["~"].middlewares[0].fn.name).toBe("route:getRole");
		});

		it("fork() wrapper is named fork", () => {
			const app = new Composer();
			app.fork((_, next) => next());
			expect(app["~"].middlewares[0].fn.name).toBe("fork");
		});

		it("tap() wrapper is named tap", () => {
			const app = new Composer();
			app.tap((_, next) => next());
			expect(app["~"].middlewares[0].fn.name).toBe("tap");
		});

		it("lazy() wrapper is named lazy:factoryName", () => {
			const app = new Composer();
			app.lazy(function loadMiddleware() {
				return (_, next) => next();
			});
			expect(app["~"].middlewares[0].fn.name).toBe("lazy:loadMiddleware");
		});

		it("decorate() wrapper is named decorate", () => {
			const app = new Composer();
			app.decorate({ foo: "bar" });
			expect(app["~"].middlewares[0].fn.name).toBe("decorate");
		});

		it("group() wrapper is named group", () => {
			const app = new Composer();
			app.group((g) => g.use((_, next) => next()));
			expect(app["~"].middlewares[0].fn.name).toBe("group");
		});

		it("extend() isolation wrapper is named extend:pluginName", () => {
			const plugin = new Composer({ name: "auth" }).derive(function getUser() {
				return { user: "alice" };
			});
			const app = new Composer().extend(plugin);
			expect(app["~"].middlewares[0].fn.name).toBe("extend:auth");
		});

		it("on() wrapper is named on:eventName", () => {
			const { Composer } = createComposer<
				{ type: string },
				{ message: { type: string } }
			>({
				discriminator: (ctx) => ctx.type,
			});
			const app = new Composer().on("message", (_, next) => next());
			expect(app["~"].middlewares[0].fn.name).toBe("on:message");
		});

		it("on() with multiple events is named on:event1|event2", () => {
			const { Composer } = createComposer<
				{ type: string },
				{ message: { type: string }; callback_query: { type: string } }
			>({
				discriminator: (ctx) => ctx.type,
			});
			const app = new Composer().on(["message", "callback_query"], (_, next) =>
				next(),
			);
			expect(app["~"].middlewares[0].fn.name).toBe("on:message|callback_query");
		});
	});

	// ─── inspect(): local vs scoped extend ───

	describe("inspect()", () => {
		it("basic middleware chain", () => {
			const app = new Composer()
				.derive(function getUser() {
					return { user: "alice" };
				})
				.guard(function isAdmin() {
					return true;
				})
				.use(async function handleRequest(_, next) {
					return next();
				});

			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "getUser",
			      "scope": "local",
			      "type": "derive",
			    },
			    {
			      "index": 1,
			      "name": "isAdmin",
			      "scope": "local",
			      "type": "guard",
			    },
			    {
			      "index": 2,
			      "name": "handleRequest",
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});

		it("omits name when handler is anonymous", () => {
			const app = new Composer()
				.derive(() => ({ x: 1 }))
				.use((_, next) => next());

			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "scope": "local",
			      "type": "derive",
			    },
			    {
			      "index": 1,
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});

		it("local extend — inner middleware hidden behind isolation wrapper", () => {
			// Plugin has BOTH: composer name "auth" AND named derive handler getUser
			const plugin = new Composer({ name: "auth" })
				.derive(function getUser() {
					return { user: "alice" };
				})
				.guard(function isAdmin() {
					return true;
				});
			// Default scope = local → wrapped in single isolation wrapper

			const app = new Composer()
				.extend(plugin)
				.use(function handleRequest(_, next) {
					return next();
				});

			// Local extend: inspect shows ONE "extend" entry, NOT the individual derive/guard.
			// The inner middleware is hidden inside the isolation wrapper.
			// type="extend", name=composer's name ("auth"), plugin="auth"
			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "auth",
			      "plugin": "auth",
			      "scope": "local",
			      "type": "extend",
			    },
			    {
			      "index": 1,
			      "name": "handleRequest",
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});

		it("scoped extend — each middleware individually visible with plugin origin", () => {
			// Same plugin, but scoped → middleware merges directly into parent
			const plugin = new Composer({ name: "auth" })
				.derive(function getUser() {
					return { user: "alice" };
				})
				.guard(function isAdmin() {
					return true;
				})
				.as("scoped");

			const app = new Composer()
				.extend(plugin)
				.use(function handleRequest(_, next) {
					return next();
				});

			// Scoped extend: each middleware preserves its original type + name.
			// plugin field shows where it came from.
			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "getUser",
			      "plugin": "auth",
			      "scope": "local",
			      "type": "derive",
			    },
			    {
			      "index": 1,
			      "name": "isAdmin",
			      "plugin": "auth",
			      "scope": "local",
			      "type": "guard",
			    },
			    {
			      "index": 2,
			      "name": "handleRequest",
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});

		it("global extend — plugin field propagates transitively", () => {
			const inner = new Composer({ name: "inner" })
				.derive(function getData() {
					return { data: 1 };
				})
				.as("global");

			const middle = new Composer({ name: "middle" })
				.extend(inner)
				.use(function processData(_, next) {
					return next();
				});

			const outer = new Composer()
				.extend(middle)
				.use(function respond(_, next) {
					return next();
				});

			// inner's derive propagates through middle to outer (global).
			// middle's use stays local, wrapped in isolation.
			// plugin tracks original source (inner), NOT intermediate (middle).
			expect(outer.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "middle",
			      "plugin": "middle",
			      "scope": "local",
			      "type": "extend",
			    },
			    {
			      "index": 1,
			      "name": "getData",
			      "plugin": "inner",
			      "scope": "global",
			      "type": "derive",
			    },
			    {
			      "index": 2,
			      "name": "respond",
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});

		it("mixed: local, scoped, and direct middleware together", () => {
			const localPlugin = new Composer({ name: "logger" }).use(
				function logRequest(_, next) {
					return next();
				},
			);

			const scopedPlugin = new Composer({ name: "auth" })
				.derive(function getUser() {
					return { user: "alice" };
				})
				.as("scoped");

			const app = new Composer()
				.decorate({ version: "1.0" })
				.extend(localPlugin)
				.extend(scopedPlugin)
				.use(function handleRequest(_, next) {
					return next();
				});

			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "scope": "local",
			      "type": "decorate",
			    },
			    {
			      "index": 1,
			      "name": "logger",
			      "plugin": "logger",
			      "scope": "local",
			      "type": "extend",
			    },
			    {
			      "index": 2,
			      "name": "getUser",
			      "plugin": "auth",
			      "scope": "local",
			      "type": "derive",
			    },
			    {
			      "index": 3,
			      "name": "handleRequest",
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});
	});

	// ─── trace() ───

	describe("trace()", () => {
		it("handler called per-middleware in order", async () => {
			const entries: MiddlewareInfo[] = [];

			const app = new Composer()
				.use(async function first(_, next) {
					return next();
				})
				.use(async function second(_, next) {
					return next();
				})
				.trace((entry) => {
					entries.push(entry);
				});

			await app.run({});
			expect(entries).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "first",
			      "scope": "local",
			      "type": "use",
			    },
			    {
			      "index": 1,
			      "name": "second",
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});

		it("receives correct MiddlewareInfo for mixed chain", async () => {
			const entries: MiddlewareInfo[] = [];

			const app = new Composer()
				.derive(function getUser() {
					return { user: "alice" };
				})
				.guard(function isAdmin() {
					return true;
				})
				.use(async function handleRequest(_, next) {
					return next();
				})
				.trace((entry) => {
					entries.push(entry);
				});

			await app.run({});
			expect(entries).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "getUser",
			      "scope": "local",
			      "type": "derive",
			    },
			    {
			      "index": 1,
			      "name": "isAdmin",
			      "scope": "local",
			      "type": "guard",
			    },
			    {
			      "index": 2,
			      "name": "handleRequest",
			      "scope": "local",
			      "type": "use",
			    },
			  ]
			`);
		});

		it("cleanup called after middleware completes", async () => {
			const cleanupCalls: (unknown | undefined)[] = [];

			const app = new Composer()
				.use(async function handler(_, next) {
					return next();
				})
				.trace(() => {
					return (error) => {
						cleanupCalls.push(error);
					};
				});

			await app.run({});
			expect(cleanupCalls).toEqual([undefined]);
		});

		it("cleanup receives error when middleware throws", async () => {
			const cleanupErrors: unknown[] = [];
			const testError = new Error("test");

			const app = new Composer()
				.use(async function failing() {
					throw testError;
				})
				.onError(() => "handled")
				.trace(() => {
					return (error) => {
						cleanupErrors.push(error);
					};
				});

			await app.run({});
			expect(cleanupErrors[0]).toBe(testError);
		});

		it("error still propagates to onError", async () => {
			const testError = new Error("test");
			let caughtError: unknown;

			const app = new Composer()
				.use(async function failing() {
					throw testError;
				})
				.onError(({ error }) => {
					caughtError = error;
					return "handled";
				})
				.trace(() => () => {});

			await app.run({});
			expect(caughtError).toBe(testError);
		});

		it("no wrapping when trace() not called (zero overhead)", async () => {
			const calls: string[] = [];

			const app = new Composer().use(async function handler(_, next) {
				calls.push("run");
				return next();
			});

			const composed = app.compose();
			await composed({});
			expect(calls).toEqual(["run"]);
			expect(app["~"].tracer).toBeUndefined();
		});

		it("trace() invalidates compiled cache", () => {
			const app = new Composer().use((_, next) => next());

			const first = app.compose();
			app.trace(() => () => {});
			const second = app.compose();
			expect(first).not.toBe(second);
		});
	});

	// ─── Stack Traces ───

	describe("stack traces", () => {
		it("internal frames are stripped — only user code remains", async () => {
			let capturedStack = "";

			const app = new Composer()
				.derive(function getUser(): never {
					throw new Error("db fail");
				})
				.onError(({ error }) => {
					capturedStack = (error as Error).stack || "";
					return "handled";
				});

			await app.run({});

			const frames = extractFrameNames(capturedStack);

			// User's function name is preserved
			expect(frames).toContain("getUser");

			// Library internals are stripped
			expect(capturedStack).not.toContain("dispatch");
			expect(capturedStack).not.toContain("compose.ts");
			expect(capturedStack).not.toContain("composer.ts");
			expect(capturedStack).toMatchInlineSnapshot(`
			  "Error: db fail
			      at getUser (Z:\\PROJECTS\\GRAMIO\\composer\\tests\\observability.test.ts:551:16)
			      at <anonymous> (Z:\\PROJECTS\\GRAMIO\\composer\\tests\\observability.test.ts:558:14)"
			`);
		});

		it("named use() handler name survives in cleaned stack", async () => {
			let capturedStack = "";

			const app = new Composer()
				.use(async function handleRequest() {
					throw new Error("fail");
				})
				.onError(({ error }) => {
					capturedStack = (error as Error).stack || "";
					return "handled";
				});

			await app.run({});

			expect(extractFrameNames(capturedStack)).toContain("handleRequest");
			expect(capturedStack).not.toContain("composer.ts");
		});

		it("trace() provides full context even with clean stacks", async () => {
			const traceLog: { type: string; name?: string; error?: boolean }[] = [];

			const plugin = new Composer({ name: "auth" })
				.derive(function getUser(): never {
					throw new Error("db fail");
				})
				.as("scoped");

			const app = new Composer()
				.extend(plugin)
				.onError(() => "handled")
				.trace((entry) => {
					traceLog.push({ type: entry.type, name: entry.name });
					return (error) => {
						if (error) {
							traceLog.push({
								type: entry.type,
								name: entry.name,
								error: true,
							});
						}
					};
				});

			await app.run({});

			// trace() captures both enter AND error exit with full metadata —
			// the reliable observability path regardless of stack trace cleaning
			expect(traceLog).toMatchInlineSnapshot(`
			  [
			    {
			      "name": "getUser",
			      "type": "derive",
			    },
			    {
			      "error": true,
			      "name": "getUser",
			      "type": "derive",
			    },
			  ]
			`);
		});
	});

	// ─── EventComposer ───

	describe("EventComposer observability", () => {
		interface MsgCtx {
			type: string;
			text: string;
		}
		interface EditCtx {
			type: string;
			edited: boolean;
		}

		const { Composer: EventComposer } = createComposer<
			{ type: string },
			{ message: MsgCtx; edit: EditCtx }
		>({
			discriminator: (ctx) => ctx.type,
		});

		it("on() sets type and name in metadata", () => {
			const app = new EventComposer().on("message", (_, next) => next());
			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "message",
			      "scope": "local",
			      "type": "on",
			    },
			  ]
			`);
		});

		it("event-specific derive() — name includes event and handler name", () => {
			const app = new EventComposer().derive("message", function getChat() {
				return { chat: 1 };
			});
			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "message:getChat",
			      "scope": "local",
			      "type": "derive",
			    },
			  ]
			`);
		});

		it("event-specific derive() with array events", () => {
			const app = new EventComposer().derive(
				["message", "edit"],
				function getChat() {
					return { chat: 1 };
				},
			);
			expect(app.inspect()).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "message|edit:getChat",
			      "scope": "local",
			      "type": "derive",
			    },
			  ]
			`);
		});

		it("trace() works on EventComposer", async () => {
			const entries: MiddlewareInfo[] = [];

			const app = new EventComposer()
				.on("message", (_, next) => next())
				.trace((entry: MiddlewareInfo) => {
					entries.push(entry);
				});

			await app.run({ type: "message" });
			expect(entries).toMatchInlineSnapshot(`
			  [
			    {
			      "index": 0,
			      "name": "message",
			      "scope": "local",
			      "type": "on",
			    },
			  ]
			`);
		});
	});
});
