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

#### `filter(predicate, ...middleware)`

Run middleware only when predicate returns true.

```ts
app.filter(
  (ctx): ctx is WithText => "text" in ctx,
  (ctx, next) => { /* ctx.text is typed */ return next(); }
);
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

### Utilities

```ts
import { noopNext, skip, stop } from "@gramio/composer";

noopNext;  // () => Promise.resolve()
skip;      // middleware that calls next()
stop;      // middleware that does NOT call next()
```
