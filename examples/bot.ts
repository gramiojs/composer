/**
 * Bot-logic examples showing practical patterns with @gramio/composer.
 *
 * Run: bun run examples/bot.ts
 */
import { Composer, createComposer } from "../src/index.ts";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Define your domain types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface BaseCtx {
	updateType: string;
	updateId: number;
}

interface MessageCtx extends BaseCtx {
	updateType: "message";
	text?: string;
	chat: { id: number; type: "private" | "group" };
	from: { id: number; firstName: string };
}

interface CallbackQueryCtx extends BaseCtx {
	updateType: "callback_query";
	data?: string;
	from: { id: number; firstName: string };
}

type EventMap = {
	message: MessageCtx;
	callback_query: CallbackQueryCtx;
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. Create typed Composer via factory
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { Composer: BotComposer } = createComposer<BaseCtx, EventMap>({
	discriminator: (ctx) => ctx.updateType,
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. Reusable plugins — declare derive once, reuse for type safety
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Auth plugin — scoped so parent sees the derived types
const withAuth = new BotComposer({ name: "auth" })
	.derive(async (ctx) => {
		const userId = "from" in ctx ? (ctx as any).from?.id : undefined;
		return {
			user: {
				id: userId as number,
				role: userId === 1 ? ("admin" as const) : ("user" as const),
			},
			isAdmin: userId === 1,
		};
	})
	.as("scoped");
// ✅ Any composer that extends withAuth gets ctx.user and ctx.isAdmin

// Logging plugin — local scope, internal timing doesn't leak
const withLogging = new BotComposer({ name: "logging" })
	.use(async (ctx, next) => {
		const start = Date.now();
		console.log(`  → [${ctx.updateType}] #${ctx.updateId}`);
		await next();
		console.log(`  ← [${ctx.updateType}] #${ctx.updateId} (${Date.now() - start}ms)`);
	});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. Pattern A: Inline commands with .on() + short-circuit
//
//    Natural middleware pattern — handler does NOT call next() to
//    stop the chain (command is "consumed"), or calls next() to
//    pass to the next handler.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const bot = new BotComposer()
	.extend(withLogging)
	.extend(withAuth) // ctx.user, ctx.isAdmin are now typed ✅

	.onError(({ context, error }) => {
		console.error(`  ✗ Error in [${context.updateType}]:`, error);
	})

	// /start — consumed (no next → chain stops)
	.on("message", (ctx, next) => {
		if (ctx.text !== "/start") return next();
		console.log(`  Hello, ${ctx.from.firstName}! Role: ${(ctx as any).user.role}`);
	})

	// /admin — guard + consume
	.on("message", (ctx, next) => {
		if (ctx.text !== "/admin") return next();
		if (!(ctx as any).isAdmin) {
			console.log("  ⛔ Access denied");
			return;
		}
		console.log("  🔑 Admin panel");
	})

	// /help
	.on("message", (ctx, next) => {
		if (ctx.text !== "/help") return next();
		console.log("  Commands: /start, /admin, /help");
	})

	// Callback queries
	.on("callback_query", (ctx, next) => {
		console.log(`  Callback: ${ctx.data} from ${ctx.from.firstName}`);
		return next();
	})

	// Fallback echo — only reached if no command matched
	.on("message", (ctx) => {
		if (ctx.text) console.log(`  Echo: ${ctx.text}`);
	});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. Pattern B: Command helper that builds middleware
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Helper that returns a raw middleware for use() — no Composer overhead
function command<T extends MessageCtx>(
	name: string,
	handler: (ctx: T) => unknown,
) {
	return (ctx: T, next: () => Promise<unknown>) => {
		if (ctx.text === `/${name}`) return handler(ctx);
		return next();
	};
}

// Usage:
const bot2 = new BotComposer()
	.extend(withAuth)
	.on("message", command("ping", () => console.log("  Pong!")))
	.on("message", command("whoami", (ctx) => {
		console.log(`  You are ${ctx.from.firstName} (#${ctx.from.id})`);
	}));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. Pattern C: Scoped plugin groups
//
//    A scoped composer that bundles multiple commands. Derives inside
//    are visible to the parent.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const adminModule = new BotComposer({ name: "admin-module" })
	// Derive only for this module — becomes scoped so parent sees it too
	.derive(() => ({
		hasPermission(role: string) {
			return role === "admin";
		},
	}))
	.on("message", (ctx, next) => {
		if (ctx.text !== "/ban") return next();
		console.log("  [admin] Ban executed");
	})
	.on("message", (ctx, next) => {
		if (ctx.text !== "/stats") return next();
		console.log("  [admin] Stats: 42 users");
	})
	.as("scoped");

const bot3 = new BotComposer()
	.extend(withAuth)
	.extend(adminModule)
	// ctx.hasPermission is available here ✅
	.on("message", (ctx) => {
		if (ctx.text) console.log(`  Unhandled: ${ctx.text}`);
	});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. Pattern D: Route-based dispatch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const bot4 = new BotComposer()
	.extend(withAuth)
	.on("message", (ctx, next) => {
		if (!ctx.text?.startsWith("/")) return next();

		// Route-based command dispatch — clean switch-like pattern
		const cmd = ctx.text.split(" ")[0].slice(1);
		return new BotComposer()
			.route(
				() => cmd,
				{
					start: () => console.log(`  Welcome, ${ctx.from.firstName}!`),
					help: () => console.log("  Help page"),
					settings: () => console.log("  Settings page"),
				},
				() => console.log(`  Unknown command: /${cmd}`),
			)
			.run(ctx as BaseCtx);
	});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. Pattern E: Reusable base with pre-configured derives
//
//    Declare once, import everywhere. All handlers get full types.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Imagine this is in "base.ts" — shared across your project
function createBot() {
	return new BotComposer()
		.extend(withLogging)
		.extend(withAuth)
		.derive(() => ({
			reply(text: string) {
				console.log(`  [reply] ${text}`);
			},
		}))
		.onError(({ error }) => {
			console.error("  ✗ Unhandled:", error);
		});
}

// In "features/greet.ts"
const greetFeature = new BotComposer({ name: "greet" }).on(
	"message",
	(ctx, next) => {
		if (ctx.text !== "/greet") return next();
		// ctx.reply is available because the base configures it
		// (type-wise it's handled by the extend chain)
		(ctx as any).reply(`Hey ${ctx.from.firstName}!`);
	},
);

// In "main.ts" — compose features onto the base
const app = createBot()
	.extend(greetFeature)
	.on("message", (ctx) => {
		// ctx.reply, ctx.user, ctx.isAdmin all typed ✅
		ctx.reply(`Unhandled: ${ctx.text}`);
	});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Run simulation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const msg = (id: number, text: string): MessageCtx => ({
	updateType: "message",
	updateId: id,
	text,
	chat: { id: 100, type: "private" },
	from: { id: 1, firstName: "Alice" },
});

const cb = (id: number, data: string): CallbackQueryCtx => ({
	updateType: "callback_query",
	updateId: id,
	data,
	from: { id: 1, firstName: "Alice" },
});

async function main() {
	console.log("── Pattern A: Inline commands ──");
	await bot.run(msg(1, "/start"));
	await bot.run(msg(2, "/admin"));
	await bot.run(msg(3, "Hey!"));
	await bot.run(cb(4, "btn_ok"));

	console.log("\n── Pattern B: Command helper ──");
	await bot2.run(msg(5, "/ping"));
	await bot2.run(msg(6, "/whoami"));

	console.log("\n── Pattern C: Scoped module ──");
	await bot3.run(msg(7, "/ban"));
	await bot3.run(msg(8, "/stats"));
	await bot3.run(msg(9, "hello"));

	console.log("\n── Pattern D: Route dispatch ──");
	await bot4.run(msg(10, "/start"));
	await bot4.run(msg(11, "/settings"));
	await bot4.run(msg(12, "/unknown"));

	console.log("\n── Pattern E: Reusable base ──");
	await app.run(msg(13, "/greet"));
	await app.run(msg(14, "hi"));
}

main();
