# @gramio/composer

[![npm](https://img.shields.io/npm/v/@gramio/composer?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@gramio/composer)
[![npm downloads](https://img.shields.io/npm/dw/@gramio/composer?logo=npm&style=flat&labelColor=000&color=3b82f6)](https://www.npmjs.org/package/@gramio/composer)
[![JSR](https://jsr.io/badges/@gramio/composer)](https://jsr.io/@gramio/composer)
[![JSR Score](https://jsr.io/badges/@gramio/composer/score)](https://jsr.io/@gramio/composer)

General-purpose, type-safe middleware composition library for TypeScript.
Zero dependencies. Cross-runtime (Bun / Node.js / Deno).

## Features

- Koa-style onion middleware composition
- Type-safe context accumulation via `derive()`
- Scope isolation (local / scoped / global) like Elysia
- Plugin deduplication by name + seed
- Abstract event system via factory pattern (`.on()`)
- Concurrent event queue with graceful shutdown
- Branching, routing, forking, lazy middleware

## Installation

```bash
# npm
npm install @gramio/composer

# bun
bun add @gramio/composer

# deno
deno add jsr:@gramio/composer
```

## Quick Start

```ts
import { Composer } from "@gramio/composer";

const app = new Composer<{ request: Request }>()
  .use(async (ctx, next) => {
    console.log("before");
    await next();
    console.log("after");
  })
  .derive((ctx) => ({
    url: new URL(ctx.request.url),
  }))
  .use((ctx, next) => {
    console.log(ctx.url.pathname); // typed!
    return next();
  });

await app.run({ request: new Request("https://example.com/hello") });
```

## API

### `compose(middlewares)`

Standalone Koa-style onion composition. Takes an array of middleware, returns a single composed middleware.

```ts
import { compose } from "@gramio/composer";

const handler = compose([
  async (ctx, next) => { console.log(1); await next(); console.log(4); },
  async (ctx, next) => { console.log(2); await next(); console.log(3); },
]);

await handler({});
// 1 → 2 → 3 → 4
```

### `Composer`

The core class. Registers middleware with type-safe context accumulation.

#### `use(...middleware)`

Register raw middleware functions.

```ts
app.use((ctx, next) => {
  // do something
  return next();
});
```

#### `derive(handler, options?)`

Compute and assign additional context properties. Subsequent middleware sees the new types.

```ts
app
  .derive((ctx) => ({ user: getUser(ctx) }))
  .use((ctx, next) => {
    ctx.user; // typed!
    return next();
  });
```

With scope propagation:

```ts
const plugin = new Composer({ name: "auth" })
  .derive((ctx) => ({ user: getUser(ctx) }), { as: "scoped" });
```

#### `guard(predicate, ...middleware)`

Two modes depending on whether handlers are provided:

**With handlers** — run middleware as side-effects when true, always continue the chain:

```ts
app.guard(
  (ctx): ctx is WithText => "text" in ctx,
  (ctx, next) => { /* ctx.text is typed */ return next(); }
);
```

**Without handlers (gate mode)** — if false, stop this composer's remaining middleware. When a type predicate is used, downstream context is narrowed:

```ts
// Only admin can reach subsequent middleware
app
  .guard((ctx) => ctx.role === "admin")
  .use(adminOnlyHandler);  // skipped if not admin

// Type predicate narrows context for all downstream handlers
app
  .guard((ctx): ctx is Ctx & { text: string } => "text" in ctx)
  .on("message", (ctx, next) => {
    ctx.text; // string (narrowed by guard)
    return next();
  });
```

When used inside an `extend()`-ed plugin, the guard stops the plugin's chain but the parent continues:

```ts
const adminPlugin = new Composer()
  .guard((ctx) => ctx.isAdmin)
  .use(adminDashboard);          // skipped if not admin

app
  .extend(adminPlugin)  // guard inside, isolated
  .use(alwaysRuns);     // parent continues regardless
```

#### `branch(predicate, onTrue, onFalse?)`

If/else branching. Static boolean optimization at registration time.

```ts
app.branch(
  (ctx) => ctx.isAdmin,
  adminHandler,
  userHandler
);
```

#### `route(router, cases, fallback?)`

Multi-way dispatch (like a switch).

```ts
app.route(
  (ctx) => ctx.type,
  {
    message: handleMessage,
    callback: handleCallback,
  },
  handleFallback
);
```

#### `fork(...middleware)`

Fire-and-forget parallel execution. Doesn't block the main chain.

```ts
app.fork(analyticsMiddleware);
```

#### `tap(...middleware)`

Run middleware but always continue the chain (cannot stop it).

```ts
app.tap(loggingMiddleware);
```

#### `lazy(factory)`

Dynamic middleware selection. Factory is called on every invocation (not cached).

```ts
app.lazy((ctx) => ctx.premium ? premiumHandler : freeHandler);
```

#### `onError(handler)`

Error boundary for all subsequent middleware.

```ts
app.onError((ctx, error) => {
  console.error(error);
});
```

#### `group(fn)`

Isolated sub-chain. Derives inside the group don't leak to the parent.

```ts
app.group((g) => {
  g.derive(() => ({ internal: true }))
   .use((ctx, next) => {
     ctx.internal; // available here
     return next();
   });
});
// ctx.internal is NOT available here
```

#### `extend(other)`

Merge another composer. Scope-aware and dedup-aware.

```ts
const auth = new Composer({ name: "auth" })
  .derive(() => ({ user: "alice" }))
  .as("scoped");

app.extend(auth);
// app now sees ctx.user
```

#### `as(scope)`

Promote all middleware to `"scoped"` (one level) or `"global"` (all levels).

#### `compose()` / `run(context)`

Compile to a single middleware or run directly.

```ts
const handler = app.compose();
await handler(ctx);

// or
await app.run(ctx);
```

### Scope System

When `parent.extend(child)`:

| Child scope | Effect in parent |
|---|---|
| `local` (default) | Isolated via `Object.create()` — derives don't leak |
| `scoped` | Merged into parent, stops there (one level) |
| `global` | Merged into parent and propagates to all ancestors |

### Plugin Deduplication

Composers with a `name` are deduplicated. Same name + seed = skipped on second extend.

```ts
const auth = new Composer({ name: "auth" });
app.extend(auth); // applied
app.extend(auth); // skipped
```

Different seed = different plugin:

```ts
const limit100 = new Composer({ name: "rate-limit", seed: { max: 100 } });
const limit200 = new Composer({ name: "rate-limit", seed: { max: 200 } });
app.extend(limit100); // applied
app.extend(limit200); // applied (different seed)
```

> [!WARNING]
> **Dedup removes middleware at registration time — not at runtime per-request.**
>
> If a shared plugin (e.g. `withUser`) is extended only inside sub-composers, its
> `derive` runs inside each sub-composer's isolation group. When dedup removes the
> derive from the second sub-composer, `ctx.user` set in the first group is **not
> visible** in the second — TypeScript types are correct, runtime value is `undefined`.
>
> **Fix:** extend the shared composer at the level where its data must be available,
> and let sub-composers extend it only for type safety (dedup prevents double execution).
>
> ```ts
> // ✅ correct — withUser runs once on the real ctx, both routers see ctx.user
> app
>   .extend(withUser)    // derive on real ctx
>   .extend(adminRouter) // withUser inside → deduped (skipped)
>   .extend(chatRouter); // withUser inside → deduped (skipped)
>
> // ⚠️  risky — works only if routers are mutually exclusive (one handles per update)
> app
>   .extend(adminRouter) // withUser runs in isolation group
>   .extend(chatRouter); // withUser deduped → chatHandlers can't see ctx.user
> ```
>
> See [`docs/layered-composers.md`](./docs/layered-composers.md) for the full breakdown.

### `createComposer(config)` — Event System

Factory that creates a Composer class with `.on()` event discrimination.

```ts
import { createComposer } from "@gramio/composer";

interface BaseCtx { updateType: string }
interface MessageCtx extends BaseCtx { text?: string }
interface CallbackCtx extends BaseCtx { data?: string }

const { Composer, EventQueue } = createComposer<BaseCtx, {
  message: MessageCtx;
  callback_query: CallbackCtx;
}>({
  discriminator: (ctx) => ctx.updateType,
});

const app = new Composer()
  .derive(() => ({ timestamp: Date.now() }))
  .on("message", (ctx, next) => {
    ctx.text;      // string | undefined
    ctx.timestamp;  // number
    return next();
  })
  .on("callback_query", (ctx, next) => {
    ctx.data;       // string | undefined
    return next();
  });
```

#### `.on()` with filters

**Filter-only (no event name)** — the 2-arg `on(filter, handler)` applies the filter to **all** events without discriminating by event type:

```ts
// Type-narrowing filter — handler sees narrowed context across all compatible events
app.on(
  (ctx): ctx is { text: string } => typeof (ctx as any).text === "string",
  (ctx, next) => {
    ctx.text; // string (narrowed)
    return next();
  },
);

// Boolean filter — no narrowing, handler gets base TOut
app.on(
  (ctx) => ctx.updateType === "message",
  (ctx, next) => {
    // no type narrowing, full context
    return next();
  },
);
```

**Event + filter** — the 3-arg `on(event, filter, handler)` supports both type-narrowing predicates and boolean filters:

```ts
// Type-narrowing filter — handler sees narrowed context
app.on(
  "message",
  (ctx): ctx is MessageCtx & { text: string } => ctx.text !== undefined,
  (ctx, next) => {
    ctx.text; // string (narrowed, not string | undefined)
    return next();
  },
);

// Boolean filter — no narrowing, handler sees full context
app.on(
  "message",
  (ctx) => ctx.text !== undefined,
  (ctx, next) => {
    ctx.text; // string | undefined (not narrowed)
    return next();
  },
);
```

The 2-arg `on()` also accepts an optional `Patch` generic for context extensions (useful in custom methods):

```ts
app.on<"message", { args: string }>("message", (ctx, next) => {
  ctx.args; // string — type-safe without casting
  return next();
});
```

`.use()` supports the same `Patch` generic — handy when a custom method enriches context before delegating to a user-provided handler:

```ts
app.use<{ args: string }>((ctx, next) => {
  ctx.args; // string — type-safe without casting
  return next();
});
```

`Patch` does not change `TOut` — it is a local escape hatch for one handler, not a permanent context extension. Use `derive()` when you want the addition to propagate to all downstream middleware.

#### `types` + `eventTypes()` — phantom type inference

TypeScript cannot partially infer type arguments, so when you need both `TEventMap` and `TMethods` inferred together, use the `types` phantom field with the `eventTypes()` helper instead of explicit type parameters:

```ts
import { createComposer, eventTypes } from "@gramio/composer";

// eventTypes<T>() returns undefined at runtime — purely for inference
const { Composer } = createComposer({
  discriminator: (ctx: BaseCtx) => ctx.updateType,
  types: eventTypes<{ message: MessageCtx; callback_query: CallbackCtx }>(),
});
// TBase inferred from discriminator, TEventMap inferred from types
```

#### `methods` — custom prototype methods

Inject framework-specific DX sugar directly onto the Composer prototype. Custom methods are preserved through **all** method chains (`on`, `use`, `derive`, `extend`, etc.). A runtime conflict check throws if a method name collides with a built-in.

**Simple methods** (no access to accumulated derives) work directly in `methods`:

```ts
const { Composer } = createComposer({
  discriminator: (ctx: BaseCtx) => ctx.updateType,
  types: eventTypes<{ message: MessageCtx }>(),
  methods: {
    hears(trigger: RegExp | string, handler: (ctx: MessageCtx) => unknown) {
      return this.on("message", (ctx, next) => {
        const text = ctx.text;
        if (
          (typeof trigger === "string" && text === trigger) ||
          (trigger instanceof RegExp && text && trigger.test(text))
        ) {
          return handler(ctx);
        }
        return next();
      });
    },
  },
});
```

**Methods that receive accumulated derives** require two steps. TypeScript cannot infer generic method signatures when `TMethods` is nested inside the return type of `createComposer`, so use `defineComposerMethods` first — its return type is directly `TMethods`, which preserves generic signatures. Then pass `typeof methods` as the 3rd type argument.

Use `ComposerLike<TThis>` as an F-bounded constraint so that `this.on(...)` is fully typed and returns `TThis` — no casts needed.

**Pattern: `this: TThis` + `ContextOf<TThis>` — zero annotation at the call site:**

```ts
import { createComposer, defineComposerMethods, eventTypes } from "@gramio/composer";
import type { ComposerLike, ContextOf, Middleware } from "@gramio/composer";

const methods = defineComposerMethods({
  command<TThis extends ComposerLike<TThis>>(
    this: TThis,
    name: string,
    handler: Middleware<MessageCtx & ContextOf<TThis>>,
  ): TThis {
    const inner: Middleware<MessageCtx & ContextOf<TThis>> = (ctx, next) => {
      if (ctx.text === `/${name}`) return handler(ctx, next);
      return next();
    };
    return this.on("message", inner);
  },
});

const { Composer } = createComposer<BaseCtx, { message: MessageCtx }, typeof methods>({
  discriminator: (ctx) => ctx.updateType,
  methods,
});

// Derives flow into the handler automatically — no annotation needed:
new Composer()
  .derive(() => ({ user: { id: 1, name: "Alice" } }))
  .command("start", (ctx, next) => {
    ctx.user.id;   // ✅ typed — inferred from ContextOf<TThis>
    ctx.text;      // ✅ string | undefined — from MessageCtx
    return next();
  });
```

#### `ContextOf<T>` — extract the current context type

Extracts `TOut` (the fully accumulated context type after all `.derive()` and `.decorate()` calls) from a Composer or EventComposer instance type.

**Naming a plugin's context type for reuse:**

```ts
import type { ContextOf } from "@gramio/composer";

const withUser = new Composer()
  .derive(async (ctx) => ({
    user: await db.getUser(ctx.userId),
  }));

// Extract the enriched context — no manual conditional type needed
export type WithUser = ContextOf<typeof withUser>;
// WithUser = { userId: string } & { user: User }

// Use it in standalone functions, other plugins, or type assertions:
function requireAdmin(ctx: WithUser) {
  if (!ctx.user.isAdmin) throw new Error("Forbidden");
}
```

**In a custom method signature** — `ContextOf<TThis>` captures all derives accumulated at the call site:

```ts
command<TThis extends ComposerLike<TThis>>(
  this: TThis,
  handler: Middleware<ContextOf<TThis>>,
): TThis
```

#### `EventContextOf<T, E>` — extract context for a specific event (global + per-event derives)

Like `ContextOf<T>`, but also includes per-event derives registered via `derive(event, handler)`.

| | Includes |
|---|---|
| `ContextOf<TThis>` | `TOut` — global derives only |
| `EventContextOf<TThis, "message">` | `TOut & TDerives["message"]` — global **and** per-event derives |

**Why it matters:** when a custom method always routes to a specific event (e.g. `command` → `"message"`), its handler should see per-event derives too. With `ContextOf` alone, a `derive("message", ...)` plugin's types are invisible inside the handler even though the value is there at runtime.

```ts
import { createComposer, defineComposerMethods, eventTypes } from "@gramio/composer";
import type { ComposerLike, EventContextOf, Middleware } from "@gramio/composer";

const methods = defineComposerMethods({
  command<TThis extends ComposerLike<TThis>>(
    this: TThis,
    name: string,
    //                  ↓ EventContextOf instead of ContextOf
    handler: Middleware<MessageCtx & EventContextOf<TThis, "message">>,
  ): TThis {
    return this.on("message", (ctx: any, next: Next) => {
      if (ctx.text === `/${name}`) return handler(ctx, next);
      return next();
    });
  },
});

const { Composer } = createComposer<BaseCtx, { message: MessageCtx }, typeof methods>({
  discriminator: (ctx) => ctx.updateType,
  methods,
});

// Per-event plugin that adds `t` only for message events:
const i18nPlugin = new Composer({ name: "i18n" })
  .derive("message", (ctx) => ({
    t: i18n.buildT(ctx.from?.languageCode ?? "en"),
  }))
  .as("scoped");

new Composer()
  .extend(i18nPlugin)
  .command("start", (ctx, next) => {
    ctx.t("Hello");   // ✅ typed — EventContextOf sees TDerives["message"]
    ctx.text;         // ✅ string | undefined — from MessageCtx
    return next();
  })
  .on("message", (ctx, next) => {
    ctx.t("Hi");      // ✅ also works here via ResolveEventCtx
    return next();
  });
```

> [!NOTE]
> If the derive is registered globally (`.derive(() => ...)` without an event name), both `ContextOf` and `EventContextOf` will see it. Per-event derives (`derive("message", ...)`) are only visible through `EventContextOf` in custom method signatures, or directly inside `.on("message", ...)` handlers.

#### `ComposerLike<T>` — minimal structural type for `this` constraints

A minimal interface `{ on(event: any, handler: any): T }` used as an F-bounded constraint on `TThis`. Makes `this.on(...)` fully typed and return `TThis` without casts.

```ts
import type { ComposerLike } from "@gramio/composer";

// Constraint in a custom method:
command<TThis extends ComposerLike<TThis>>(this: TThis, ...): TThis {
  return this.on("message", inner); // returns TThis — no `as TThis` needed
}
```

### `EventQueue`

Concurrent event queue with graceful shutdown.

```ts
import { EventQueue } from "@gramio/composer";

const queue = new EventQueue<RawEvent>(async (event) => {
  const ctx = createContext(event);
  return app.run(ctx);
});

queue.add(event);
queue.addBatch(events);

// Graceful shutdown (waits up to 5s for pending handlers)
await queue.stop(5000);
```

### Macro System

Declarative handler options inspired by [Elysia macros](https://elysiajs.com/patterns/macro.md). Register reusable behaviors (guards, rate-limits, auth) as macros, then activate them via an options object on handler methods.

#### `macro(name, definition)` / `macro(definitions)`

Register macros on a Composer or EventComposer instance.

```ts
import { Composer, type MacroDef, type ContextCallback } from "@gramio/composer";

// Boolean shorthand macro — plain hooks object
const onlyAdmin: MacroDef<void, {}> = {
  preHandler: (ctx, next) => {
    if (ctx.role !== "admin") return; // stops chain
    return next();
  },
};

// Parameterized macro — function receiving options
interface ThrottleOptions {
  limit: number;
  window?: number;
  onLimit?: ContextCallback; // ← replaced with actual ctx type at call site
}

const throttle: MacroDef<ThrottleOptions, {}> = (opts) => ({
  preHandler: createThrottleMiddleware(opts),
});

// Macro with derive — enriches handler context
interface AuthDerived { user: { id: number; name: string } }

const auth: MacroDef<void, AuthDerived> = {
  derive: async (ctx) => {
    const user = await getUser(ctx.token);
    if (!user) return; // void = stop chain (guard behavior)
    return { user };
  },
};

const app = new Composer()
  .macro("onlyAdmin", onlyAdmin)
  .macro({ throttle, auth }); // batch registration
```

#### `buildFromOptions(macros, options, handler)`

Runtime helper that composes a handler with macro hooks. Used internally by frameworks to wire macros into handler methods.

```ts
import { buildFromOptions } from "@gramio/composer";

// Execution order:
// 1. options.preHandler[] (explicit guards — user controls order)
// 2. Per-macro in options property order:
//    a. macro.preHandler (guard middleware)
//    b. macro.derive (context enrichment; void = stop chain)
// 3. Main handler
const composed = buildFromOptions(
  app["~"].macros,
  { auth: true, throttle: { limit: 5 } },
  mainHandler,
);
```

#### Macro Types

```ts
import type {
  MacroDef,          // Macro definition (function or hooks object)
  MacroHooks,        // { preHandler?, derive? }
  MacroDefinitions,  // Record<string, MacroDef<any, any>>
  ContextCallback,   // Marker type for context-aware callbacks
  WithCtx,           // Recursively replaces ContextCallback with real ctx type
  HandlerOptions,    // Builds the options parameter type for handler methods
  DeriveFromOptions, // Collects derive types from activated macros
  MacroOptionType,   // Extracts option type from MacroDef
  MacroDeriveType,   // Extracts derive return type from MacroDef
} from "@gramio/composer";
```

### Utilities

```ts
import { noopNext, skip, stop } from "@gramio/composer";

noopNext;  // () => Promise.resolve()
skip;      // middleware that calls next()
stop;      // middleware that does NOT call next()
```
