# `@gramio/composer` — Full API Specification

General-purpose, type-safe middleware composition library for TypeScript.
Zero dependencies. Cross-runtime (Bun / Node.js / Deno).

## Features

- Koa-style onion middleware composition
- Type-safe context accumulation via `derive()`
- Scope isolation (local / scoped / global) like Elysia
- Plugin deduplication by name + seed
- Abstract event system via factory pattern (`.on()`)
- Opt-in concurrent event queue with graceful shutdown
- Branching, routing, forking, lazy middleware

---

## File Structure

```
src/
  types.ts        — all type definitions
  compose.ts      — standalone compose() function
  composer.ts     — Composer class
  factory.ts      — createComposer() factory
  queue.ts        — EventQueue
  index.ts        — barrel exports
```

---

## 1. Core Types (`types.ts`)

```typescript
/** next() continuation function */
type Next = () => Promise<unknown>;

/** Middleware function: receives context and next */
type Middleware<T> = (context: T, next: Next) => unknown;

/** Error handler receives an object with error, context, and resolved kind */
type ErrorHandler<T> = (params: {
  error: unknown;
  context: T;
  kind?: string;
}) => unknown;

/** Function that computes additional context properties */
type DeriveHandler<T, D> = (context: T) => D | Promise<D>;

/** Lazy middleware factory — called per invocation */
type LazyFactory<T> = (context: T) => Middleware<T> | Promise<Middleware<T>>;

/** Single value or array */
type MaybeArray<T> = T | T[];

/** Scope level for middleware propagation */
type Scope = "local" | "scoped" | "global";

/** Internal middleware entry with scope annotation */
interface ScopedMiddleware<T> {
  fn: Middleware<T>;
  scope: Scope;
}

/** Composer constructor options */
interface ComposerOptions {
  name?: string;
  seed?: unknown;
}
```

---

## 2. `compose()` — Standalone Function (`compose.ts`)

### Signature

```typescript
function compose<T>(middlewares: Middleware<T>[]): Middleware<T>;
```

### Behavior

- Takes an array of middleware functions, returns a single composed middleware
- Koa-style onion model: each middleware receives `(context, next)`, calling `next()` invokes the next middleware
- Code before `await next()` runs top-down, code after runs bottom-up
- Guards against `next()` called multiple times — throws `Error("next() called multiple times")`
- Catches both sync throws and async rejections, converts to `Promise.reject()`
- When all middleware exhausted, calls the optional `next` parameter passed to the composed function (terminal continuation)

### Fast paths

- Empty array: return pass-through middleware `(_, next) => next?.() ?? Promise.resolve()`
- Single element: return that middleware directly (no wrapping)

### Algorithm

```
composed(context, next?) {
  let lastIndex = -1

  dispatch(i):
    if i <= lastIndex → reject("next() called multiple times")
    lastIndex = i
    fn = middlewares[i] ?? next
    if !fn → resolve()
    try: resolve(fn(context, () => dispatch(i + 1)))
    catch: reject(error)

  return dispatch(0)
}
```

---

## 3. `Composer` Class (`composer.ts`)

### Generics

```typescript
class Composer<
  TIn      extends object = {},    // Required input context type
  TOut     extends TIn    = TIn,   // Internal context type (after derives)
  TExposed extends object = {}     // Types that propagate to parent via extend()
>
```

**Why three generics:**

- `TIn` — what the CALLER must provide. `compose()` returns `Middleware<TIn>`
- `TOut` — what middleware INSIDE the chain sees (grows via `derive()`)
- `TExposed` — what propagates to the PARENT when this composer is `extend()`-ed. Empty by default (local scope). Set to `TOut` via `.as("scoped" | "global")`

### Constructor

```typescript
constructor(options?: ComposerOptions)
```

- `options.name` — optional string name for deduplication
- `options.seed` — optional value for dedup differentiation (same name, different seed = different plugin)

### 3.1 Middleware Methods

#### `use(...middleware)`

```typescript
use(...middleware: Middleware<TOut>[]): Composer<TIn, TOut, TExposed>
```

- Registers one or more raw middleware functions
- Middleware sees the full `TOut` context
- Does NOT change `TOut` or `TExposed` — just adds execution steps

#### `derive(handler)`

```typescript
derive<D extends object>(
  handler: DeriveHandler<TOut, D>
): Composer<TIn, TOut & D, TExposed>
```

- Registers a middleware that:
  1. Calls `handler(context)` (may be async)
  2. Assigns all returned properties onto the context: `Object.assign(context, result)`
  3. Calls `next()`
- `TOut` grows by `& D` — subsequent middleware sees the new properties
- `TExposed` is NOT affected (local by default)

#### `derive(handler, options)` — with scope

```typescript
derive<D extends object>(
  handler: DeriveHandler<TOut, D>,
  options: { as: "scoped" | "global" }
): Composer<TIn, TOut & D, TExposed & D>
```

- Same as above, but the derive is scoped
- Both `TOut` AND `TExposed` grow by `& D`

#### `guard(predicate, ...middleware)` — conditional with type narrowing

```typescript
// Overload 1: type predicate
guard<S extends TOut>(
  predicate: (context: TOut) => context is S,
  ...middleware: Middleware<S>[]
): Composer<TIn, TOut, TExposed>

// Overload 2: boolean predicate
guard(
  predicate: (context: TOut) => boolean | Promise<boolean>,
  ...middleware: Middleware<TOut>[]
): Composer<TIn, TOut, TExposed>
```

**With handlers** (side-effects mode):
- If predicate returns true → run the given middleware, then call next
- If predicate returns false → skip middleware, call next immediately

**Without handlers** (gate mode):
- If predicate returns true → call next (continue chain)
- If predicate returns false → stop (don't call next)

- `TOut` and `TExposed` are unchanged

#### `branch(predicate, onTrue, onFalse?)`

```typescript
branch(
  predicate: ((context: TOut) => boolean | Promise<boolean>) | boolean,
  onTrue: Middleware<TOut>,
  onFalse?: Middleware<TOut>
): Composer<TIn, TOut, TExposed>
```

- If predicate is `true` (or function returns true) → run `onTrue`
- If predicate is `false` (or function returns false) → run `onFalse` (or call `next()`)
- **Static boolean optimization:** if predicate is a literal boolean, resolve at registration time (no runtime check)

#### `route(router, cases, fallback?)`

```typescript
route<K extends string>(
  router: (context: TOut) => K | Promise<K>,
  cases: Partial<Record<K, Middleware<TOut>>>,
  fallback?: Middleware<TOut>
): Composer<TIn, TOut, TExposed>
```

- Calls `router(context)` to get a key
- Runs `cases[key]` if exists, otherwise `fallback`, otherwise `next()`
- Multi-way dispatch (like a switch statement)

#### `fork(...middleware)`

```typescript
fork(...middleware: Middleware<TOut>[]): Composer<TIn, TOut, TExposed>
```

- Schedules middleware to run in parallel (fire-and-forget)
- Immediately calls `next()` without waiting
- Implementation: `Promise.resolve().then(() => compose(middleware)(ctx, noopNext))` — no `setImmediate`
- Errors in forked middleware are silently caught (do not affect the main chain)

#### `tap(...middleware)`

```typescript
tap(...middleware: Middleware<TOut>[]): Composer<TIn, TOut, TExposed>
```

- Runs middleware with `noopNext` (cannot stop the chain)
- Always calls `next()` after, regardless of what the middleware does

#### `lazy(factory)`

```typescript
lazy(factory: LazyFactory<TOut>): Composer<TIn, TOut, TExposed>
```

- Calls `factory(context)` on EVERY invocation (not cached, unlike middleware-io)
- Runs the returned middleware
- Useful for dynamic middleware selection based on context

#### `onError(handler)`

```typescript
onError(handler: ErrorHandler<TOut>): Composer<TIn, TOut, TExposed>
```

- Pushes handler to `["~"].onErrors` array (NOT into the middleware chain)
- At `compose()` time, the entire middleware chain is wrapped in a single try/catch
- On error:
  1. Resolves `kind` by matching error against `["~"].errorsDefinitions` via `instanceof`
  2. Iterates handlers in registration order, calling `handler({ error, context, kind })`
  3. First handler to return non-`undefined` wins — error is considered handled
  4. If no handler returns a value → `console.error("[composer] Unhandled error:", error)` (no re-throw)
- Multiple `onError()` calls add to the array (Elysia-style chain, not nested boundaries)
- `extend()` merges error handlers from child to parent

### 3.2 Scope System

#### `as(scope)` — batch scope promotion

```typescript
as(scope: "scoped"): Composer<TIn, TOut, TOut>
as(scope: "global"): Composer<TIn, TOut, TOut>
```

- Promotes ALL previously registered middleware to the given scope
- Returns the same composer with `TExposed = TOut`
- **"scoped"**: middleware propagates ONE level up when `extend()`-ed
- **"global"**: middleware propagates to ALL ancestors

#### Runtime behavior matrix

When `parent.extend(child)`:

```
child middleware scope │ What happens in parent
──────────────────────┼──────────────────────────────────────────────
local (default)       │ Wrapped in isolated group (Object.create)
                      │ Does NOT affect parent's subsequent middleware
──────────────────────┼──────────────────────────────────────────────
scoped                │ Merged into parent's chain as LOCAL
                      │ DOES affect parent's subsequent middleware
                      │ Does NOT propagate further (grandparent won't see it)
──────────────────────┼──────────────────────────────────────────────
global                │ Merged into parent's chain as GLOBAL
                      │ DOES affect parent's subsequent middleware
                      │ DOES propagate further (grandparent will see it too)
```

#### Isolation mechanism

Local middleware from an extended composer is isolated via prototype chain:

```typescript
// When extend() encounters local middleware:
const isolatedMiddleware = async (ctx, next) => {
  const scopedCtx = Object.create(ctx);    // inherits parent properties
  await localChain(scopedCtx, noopNext);   // local derives write to scopedCtx
  // parent ctx is NOT modified
  await next();
};
```

- `Object.create(ctx)` creates a new object with `ctx` as prototype
- Reads from `scopedCtx` fall through to `ctx` (parent data is visible inside the group)
- Writes to `scopedCtx` create own properties (do not modify `ctx`)
- After the isolated section, parent chain continues with original `ctx`

### 3.3 Deduplication

#### How it works

Each Composer can have a `name` (and optional `seed`). When `extend()` is called:

1. If child has no `name` → always extend (no dedup check)
2. Compute dedup key: `name` + `JSON.stringify(seed ?? null)`
3. Check if key exists in parent's `extended` Set
4. If exists → skip (no-op at runtime, types still widen)
5. If not → extend normally, add key to Set

```typescript
class Composer {
  private extended = new Set<string>();

  extend(other) {
    if (other.name) {
      const key = `${other.name}:${JSON.stringify(other.seed ?? null)}`;
      if (this.extended.has(key)) return this; // deduplicated
      this.extended.add(key);
    }
    // ... proceed with merge
  }
}
```

#### Dedup inherits transitively

When `parent.extend(child)`, parent also inherits child's `extended` Set. So if child already extended plugin X, parent won't extend it again.

### 3.4 Composition Methods

#### `group(fn)` — isolated sub-chain

```typescript
group(fn: (composer: Composer<TOut, TOut, {}>) => void): Composer<TIn, TOut, TExposed>
```

- Creates a fresh Composer for the group
- Calls `fn(groupComposer)` — user registers middleware on it
- Group is compiled into a SINGLE isolated middleware in the parent chain
- Group's derives/middleware do NOT leak to parent (`TOut` unchanged, `TExposed` unchanged)
- Isolation via `Object.create(ctx)` (same as local extend)

#### `extend(other)` — merge another composer

```typescript
extend<UIn extends object, UOut extends UIn, UExposed extends object>(
  other: Composer<UIn, UOut, UExposed>
): Composer<TIn, TOut & UExposed, TExposed>
```

- Merges `other`'s middleware into this composer
- Scope-aware: local middleware is isolated, scoped/global middleware is merged
- Dedup-aware: checks name/seed before merging
- Only `UExposed` (other's exposed types) are added to parent's `TOut`
- Parent's own `TExposed` is unchanged

#### `compose()` — compile to middleware

```typescript
compose(): Middleware<TIn>
```

- Compiles all registered middleware into a single function
- Returns `Middleware<TIn>` — caller only needs to provide `TIn`, derives are internal
- Uses lazy compilation: first call compiles and caches, subsequent calls return cached
- Adding new middleware via `use()`/`derive()`/etc. invalidates the cache (dirty flag)

#### `run(context, next?)` — direct execution

```typescript
run(context: TIn, next?: Next): Promise<void>
```

- Shorthand for `this.compose()(context, next ?? noopNext)`

---

## 4. `createComposer()` — Factory with Events (`factory.ts`)

### Purpose

Creates a configured Composer class with type-safe `.on()` event discrimination.
The base `Composer` is event-agnostic. The factory adds event support.

### Signature

```typescript
function createComposer<
  TBase extends object,
  TEventMap extends Record<string, TBase> = {}
>(config: {
  /** Runtime: extract event type string from context */
  discriminator: (context: TBase) => string;
}): {
  /** Configured Composer class with .on() support */
  Composer: EventComposerConstructor<TBase, TEventMap>;

  /** Standalone compose function (re-export) */
  compose: typeof compose;

  /** EventQueue class (re-export) */
  EventQueue: typeof EventQueue;
}
```

### `EventComposer` — returned by factory

Extends the base `Composer` with `.on()`:

```typescript
class EventComposer<
  TIn extends TBase = TBase,
  TOut extends TIn = TIn,
  TExposed extends object = {}
> extends Composer<TIn, TOut, TExposed> {

  /**
   * Register handler for specific event type(s).
   * Sugar over use() + discriminator check.
   */
  on<E extends keyof TEventMap & string>(
    event: MaybeArray<E>,
    handler: Middleware<TOut & TEventMap[E]>
  ): EventComposer<TIn, TOut, TExposed>;
}
```

### `.on()` behavior

- Accepts single event name or array of event names
- Registers a middleware that:
  1. Calls `discriminator(context)` to get the current event type
  2. If it matches `event` (or any element of the array) → run `handler`
  3. If no match → call `next()`
- Handler receives `TOut & TEventMap[E]` — accumulated derives + event-specific context type

### Implementation hint

```typescript
on(event, handler) {
  const events = Array.isArray(event) ? event : [event];
  return this.use((ctx, next) => {
    if (events.includes(this.config.discriminator(ctx)))
      return handler(ctx, next);
    return next();
  });
}
```

### Usage Example

```typescript
// Define event map
interface BaseCtx { updateType: string }
interface MessageCtx extends BaseCtx { text?: string; chat: Chat }
interface CallbackCtx extends BaseCtx { data?: string }

// Create configured Composer
const { Composer, EventQueue } = createComposer<BaseCtx, {
  message: MessageCtx;
  callback_query: CallbackCtx;
}>({
  discriminator: (ctx) => ctx.updateType,
});

// Use it
const app = new Composer()
  .derive((ctx) => ({ timestamp: Date.now() }))
  .on("message", (ctx, next) => {
    ctx.text;       // string | undefined  ← from MessageCtx
    ctx.timestamp;  // number              ← from derive
    return next();
  })
  .on("callback_query", (ctx, next) => {
    ctx.data;       // string | undefined  ← from CallbackCtx
    ctx.timestamp;  // number              ← from derive
    return next();
  });
```

### Extending EventComposer

EventComposers created via factory support all base Composer methods:
`derive()`, `guard()`, `branch()`, `route()`, `fork()`, `tap()`, `lazy()`,
`onError()`, `group()`, `extend()`, `as()`, `compose()`, `run()`.

When `.extend()`-ing another EventComposer, they must share the same factory
(same discriminator and event map).

---

## 5. `EventQueue` — Concurrent Event Processing (`queue.ts`)

### Purpose

Concurrent event queue with graceful shutdown support.
Processes events in parallel (like an event loop), not sequentially.
Opt-in — only used when you need queue semantics.

### Signature

```typescript
class EventQueue<T> {
  constructor(handler: (event: T) => Promise<unknown>);

  /** Add a single event to the queue */
  add(event: T): void;

  /** Add multiple events to the queue */
  addBatch(events: T[]): void;

  /**
   * Graceful shutdown:
   * 1. Stop accepting new events from being processed
   * 2. Wait for all in-flight handlers to complete
   * 3. If timeout exceeded, resolve anyway (force stop)
   * Default timeout: 3000ms
   */
  stop(timeout?: number): Promise<void>;

  /**
   * Returns a promise that resolves when the queue is idle
   * (no pending handlers AND no queued events)
   */
  onIdle(): Promise<void>;

  /** Number of currently executing handlers */
  get pending(): number;

  /** Number of events waiting in queue */
  get queued(): number;

  /** Whether the queue is actively processing */
  get isActive(): boolean;
}
```

### Behavior

1. `add(event)` pushes to internal array and starts processing
2. Processing loop: while queue has items, shift and call `handler(event)` — each handler runs as a separate Promise (concurrent)
3. Each completed handler is removed from the `pendingUpdates` Set
4. When both queue and pending are empty → resolve any `onIdle()` promise
5. `stop(timeout)` sets `isActive = false`, waits for `onIdle()` OR timeout (whichever first)

### Usage

```typescript
const { Composer, EventQueue } = createComposer<BaseCtx, EventMap>({
  discriminator: (ctx) => ctx.type,
});

const app = new Composer()
  .on("message", handleMessage)
  .on("callback_query", handleCallback);

// Wire up the queue
const queue = new EventQueue<RawUpdate>((raw) => {
  const ctx = createContext(raw);  // your context creation logic
  return app.run(ctx);
});

// Feed events
queue.add(rawUpdate);
queue.addBatch(updates);

// Graceful shutdown
await queue.stop(5000);
```

---

## 6. Utilities

```typescript
/** No-op next function: () => Promise.resolve() */
const noopNext: Next;

/** Pass-through middleware: calls next() immediately */
const skip: Middleware<any>;

/** Terminal middleware: does NOT call next() */
const stop: Middleware<any>;
```

---

## 7. Exports (`index.ts`)

```typescript
// Core
export { compose } from "./compose";
export { Composer } from "./composer";
export { createComposer } from "./factory";
export { EventQueue } from "./queue";

// Types
export type {
  Next,
  Middleware,
  ErrorHandler,
  DeriveHandler,
  LazyFactory,
  MaybeArray,
  Scope,
  ComposerOptions,
} from "./types";

// Utilities
export { noopNext, skip, stop } from "./utils";
```

---

## 8. Complete Examples

### 8.1 Basic usage (no events)

```typescript
import { Composer } from "@gramio/composer";

const app = new Composer<{ request: Request }>()
  .use((ctx, next) => {
    console.log("before");
    await next();
    console.log("after");
  })
  .derive((ctx) => ({
    url: new URL(ctx.request.url),
  }))
  .use((ctx, next) => {
    console.log(ctx.url.pathname);  // typed!
    return next();
  });

// Compile and run
const handler = app.compose();
await handler({ request: new Request("https://example.com/hello") });
```

### 8.2 Scope isolation

```typescript
import { Composer } from "@gramio/composer";

// Plugin with LOCAL scope (default) — derives don't leak
const analytics = new Composer<{ request: Request }>({ name: "analytics" })
  .derive((ctx) => ({ startTime: Date.now() }))
  .use((ctx, next) => {
    await next();
    console.log(`Took ${Date.now() - ctx.startTime}ms`);
  });
// analytics.TExposed = {} — nothing propagates

// Plugin with SCOPED — derives propagate to parent
const auth = new Composer<{ request: Request }>({ name: "auth" })
  .derive((ctx) => ({
    user: parseJWT(ctx.request.headers.get("authorization")),
  }))
  .as("scoped");
// auth.TExposed = { user: User } — propagates one level

// App
const app = new Composer<{ request: Request }>()
  .extend(analytics)  // analytics runs, but app doesn't see startTime
  .extend(auth)        // app sees user ✅
  .use((ctx, next) => {
    ctx.user;       // ✅ typed (from auth, scoped)
    ctx.startTime;  // ❌ TypeScript error (from analytics, local)
    return next();
  });
```

### 8.3 Scope: scoped vs global

```typescript
const inner = new Composer({ name: "inner" })
  .derive(() => ({ a: 1 }))
  .as("scoped");   // propagates ONE level

const middle = new Composer({ name: "middle" })
  .extend(inner)    // middle sees { a: 1 } ✅
  .derive(() => ({ b: 2 }))
  .as("scoped");

const outer = new Composer()
  .extend(middle);
  // outer sees { b: 2 } ✅ (middle is scoped)
  // outer sees { a: 1 }? NO ❌ — inner was scoped, stopped at middle

// With global:
const innerGlobal = new Composer({ name: "inner-global" })
  .derive(() => ({ a: 1 }))
  .as("global");   // propagates ALL levels

const middle2 = new Composer({ name: "middle2" })
  .extend(innerGlobal);

const outer2 = new Composer()
  .extend(middle2);
  // outer2 sees { a: 1 } ✅ — inner was global, propagates through middle
```

### 8.4 Deduplication

```typescript
const auth = new Composer<BaseCtx>({ name: "auth" })
  .derive((ctx) => ({ user: getUser(ctx) }))
  .as("scoped");

const app = new Composer<BaseCtx>()
  .extend(auth)   // ✅ applied
  .extend(auth);  // ⏭️ skipped (name "auth" already registered)

// With seed — same name, different config = different plugin
const rateLimit = (max: number) =>
  new Composer<BaseCtx>({ name: "rate-limit", seed: { max } })
    .use(createLimiter(max));

const app2 = new Composer<BaseCtx>()
  .extend(rateLimit(100))   // ✅ applied
  .extend(rateLimit(200))   // ✅ applied (different seed)
  .extend(rateLimit(100));  // ⏭️ skipped (same name + seed)

// Transitive dedup: if child already extended X, parent won't extend X again
const pluginA = new Composer({ name: "A" }).use(mwA);
const pluginB = new Composer({ name: "B" }).extend(pluginA).use(mwB);

const app3 = new Composer()
  .extend(pluginB)   // extends B (which includes A)
  .extend(pluginA);  // ⏭️ skipped — A already came through B
```

### 8.5 Event system with factory

```typescript
import { createComposer } from "@gramio/composer";

// === Define your event types ===
interface BaseCtx {
  updateType: string;
  updateId: number;
}

interface MessageCtx extends BaseCtx {
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string };
}

interface CallbackQueryCtx extends BaseCtx {
  data?: string;
  message?: MessageCtx;
}

type EventMap = {
  message: MessageCtx;
  callback_query: CallbackQueryCtx;
};

// === Create configured Composer ===
const { Composer, EventQueue } = createComposer<BaseCtx, EventMap>({
  discriminator: (ctx) => ctx.updateType,
});

// === Build your app ===
const app = new Composer()
  // Global middleware — runs for ALL events
  .use((ctx, next) => {
    console.log(`[${ctx.updateType}] #${ctx.updateId}`);
    return next();
  })

  // Derive — adds properties for all subsequent handlers
  .derive((ctx) => ({
    timestamp: Date.now(),
  }))

  // Event-specific handler
  .on("message", (ctx, next) => {
    // ctx: BaseCtx & { timestamp: number } & MessageCtx
    if (ctx.text === "/start") {
      console.log(`Hello, ${ctx.from?.first_name}!`);
    }
    return next();
  })

  // Multiple events
  .on(["message", "callback_query"], (ctx, next) => {
    // ctx: BaseCtx & { timestamp: number } & (MessageCtx | CallbackQueryCtx)
    // ^ union of matching event types when using array
    return next();
  })

  // Error handler — logs all errors (returns undefined → passes to next handler)
  .onError(({ context, error }) => {
    console.error(`Error in ${context.updateType}:`, error);
  });

// === Process events ===
const queue = new EventQueue<RawUpdate>((raw) => {
  const ctx = createContext(raw);  // your logic
  return app.run(ctx);
});

queue.add(rawUpdate);
```

### 8.6 Reusable composers (plugin pattern)

```typescript
const { Composer } = createComposer<BaseCtx, EventMap>({
  discriminator: (ctx) => ctx.updateType,
});

// === Define reusable "plugins" ===

// Auth plugin — scoped, so parent sees the derive
const withAuth = new Composer({ name: "auth" })
  .derive((ctx) => ({
    user: getUserFromDB(ctx),
    isAdmin: checkAdmin(ctx),
  }))
  .as("scoped");

// Logging plugin — local, internal only
const withLogging = new Composer({ name: "logging" })
  .use((ctx, next) => {
    const start = Date.now();
    await next();
    console.log(`${ctx.updateType} took ${Date.now() - start}ms`);
  });

// Command handler group — local, self-contained
const commands = new Composer({ name: "commands" })
  .on("message", (ctx, next) => {
    if (ctx.text?.startsWith("/help")) {
      // handle /help
      return;
    }
    return next();
  });

// === Compose the app ===
const app = new Composer()
  .extend(withAuth)     // ctx.user and ctx.isAdmin available ✅
  .extend(withLogging)  // logging runs but doesn't add to ctx
  .extend(commands)     // command handlers registered
  .on("message", (ctx, next) => {
    ctx.user;      // ✅ from withAuth (scoped)
    ctx.isAdmin;   // ✅ from withAuth (scoped)
    return next();
  });
```

### 8.7 Group isolation

```typescript
const app = new Composer<{ request: Request }>()
  .use(globalLogger)
  .group((g) => {
    // This group has its own scope
    g.derive((ctx) => ({ internal: computeExpensive(ctx) }))
     .use((ctx, next) => {
       ctx.internal;  // ✅ available inside group
       return next();
     });
  })
  // Outside the group:
  .use((ctx, next) => {
    ctx.internal;  // ❌ TypeScript error — group's derive is isolated
    return next();
  });
```

### 8.8 Integration sketch: how GramIO would use this

```typescript
// In @gramio/gramio

import { createComposer, EventQueue } from "@gramio/composer";
import type { TelegramUpdate } from "@gramio/types";
import { contextsMappings, type UpdateName } from "@gramio/contexts";

// Create the framework's Composer
const { Composer: BaseComposer } = createComposer<
  Context<AnyBot>,
  ContextEventMap  // { message: MessageContext, callback_query: CallbackQueryContext, ... }
>({
  discriminator: (ctx) => ctx.updateType,
});

// GramIO's Bot extends the configured Composer
class Bot<Errors, Derives> {
  private composer = new BaseComposer();
  private queue: EventQueue<TelegramUpdate>;

  constructor(token: string) {
    this.queue = new EventQueue((update) => this.handleUpdate(update));
  }

  // Thin wrappers over Composer methods
  on(event, handler)      { this.composer.on(event, handler); return this; }
  use(handler)             { this.composer.use(handler); return this; }
  derive(handler)          { this.composer.derive(handler); return this; }

  // GramIO-specific methods (NOT in composer)
  command(name, handler)   { /* uses .on("message", ...) + command parsing */ }
  hears(trigger, handler)  { /* uses .on("message", ...) + text matching */ }

  // GramIO Plugin system (wraps composer.extend + hooks + errors)
  extend(plugin) {
    this.composer.extend(plugin.composer);
    // + merge hooks, error definitions, decorators
    return this;
  }

  // Context creation from raw update
  private async handleUpdate(data: TelegramUpdate) {
    const updateType = Object.keys(data).at(1) as UpdateName;
    const ctx = new contextsMappings[updateType]({ ... });
    return this.composer.run(ctx);
  }

  // Graceful shutdown
  async stop() {
    await this.queue.stop(5000);
  }
}
```

---

## 9. Implementation Notes

### 9.1 Lazy compilation with dirty flag

```typescript
class Composer {
  private middlewares: ScopedMiddleware<TOut>[] = [];
  private _compiled: Middleware<TIn> | null = null;

  private invalidate() {
    this._compiled = null;
  }

  use(mw) {
    this.middlewares.push({ fn: mw, scope: "local" });
    this.invalidate();
    return this;
  }

  compose() {
    if (!this._compiled) {
      const chain = compose(this.middlewares.map(m => m.fn));
      const onErrors = this.onErrors;
      const errorsDefinitions = this.errorsDefinitions;

      this._compiled = async (ctx, next?) => {
        try {
          return await chain(ctx, next);
        } catch (error) {
          // Resolve kind via instanceof against registered error classes
          let kind: string | undefined;
          for (const [k, ErrorClass] of Object.entries(errorsDefinitions)) {
            if (error instanceof ErrorClass) { kind = k; break; }
          }
          // Iterate handlers — first to return non-undefined wins
          for (const handler of onErrors) {
            const result = await handler({ error, context: ctx, kind });
            if (result !== undefined) return result;
          }
          // Default: log, don't re-throw (no process crash)
          console.error("[composer] Unhandled error:", error);
        }
      };
    }
    return this._compiled;
  }
}
```

### 9.2 Scope storage

Each middleware entry stores its scope:

```typescript
interface ScopedMiddleware<T> {
  fn: Middleware<T>;
  scope: Scope;  // "local" | "scoped" | "global"
}
```

`.as("scoped")` retroactively changes all existing entries:

```typescript
as(scope: "scoped" | "global") {
  for (const entry of this.middlewares) {
    // only promote, never demote
    if (scope === "global" || entry.scope === "local") {
      entry.scope = scope;
    }
  }
  this.invalidate();
  return this;
}
```

### 9.3 Extend merge logic

```typescript
extend(other) {
  // 1. Dedup check
  // 2. Inherit other's extended set (transitive dedup)
  for (const key of other.extended) {
    this.extended.add(key);
  }

  // 3. Merge error definitions and error handlers
  Object.assign(this.errorsDefinitions, other.errorsDefinitions);
  this.onErrors.push(...other.onErrors);

  // 4. Process other's middleware by scope
  const localMws = other.middlewares.filter(m => m.scope === "local");
  const scopedMws = other.middlewares.filter(m => m.scope === "scoped");
  const globalMws = other.middlewares.filter(m => m.scope === "global");

  // Local → wrap in isolated group
  if (localMws.length > 0) {
    const isolated = this.createIsolatedMiddleware(localMws);
    this.middlewares.push({ fn: isolated, scope: "local" });
  }

  // Scoped → add as LOCAL in parent (stops here)
  for (const mw of scopedMws) {
    this.middlewares.push({ fn: mw.fn, scope: "local" });
  }

  // Global → add as GLOBAL in parent (continues propagating)
  for (const mw of globalMws) {
    this.middlewares.push({ fn: mw.fn, scope: "global" });
  }

  this.invalidate();
  return this;
}

private createIsolatedMiddleware(middlewares: ScopedMiddleware[]): Middleware {
  const chain = compose(middlewares.map(m => m.fn));
  return async (ctx, next) => {
    const scopedCtx = Object.create(ctx);
    await chain(scopedCtx, noopNext);
    await next();
  };
}
```

### 9.4 Cross-runtime compatibility

- NO `setImmediate` — use `Promise.resolve().then()` for fork
- NO Node.js-specific APIs
- ESM-first with proper `exports` field in package.json
- Target: ES2022+ (modern async/await, no transpilation needed)

### 9.5 Package.json

```json
{
  "name": "@gramio/composer",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "bun test"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

### 9.6 Testing checklist

- [ ] `compose()` — empty array, single middleware, multiple middleware
- [ ] `compose()` — next() called multiple times throws
- [ ] `compose()` — sync and async middleware
- [ ] `compose()` — error propagation (sync throw, async reject)
- [ ] `compose()` — onion order (before/after next())
- [ ] `Composer.use()` — registers middleware, runs in order
- [ ] `Composer.derive()` — adds properties to context, types accumulate
- [ ] `Composer.guard()` — with handlers: runs middleware only when predicate is true
- [ ] `Composer.guard()` — without handlers: gates the chain (false → stop)
- [ ] `Composer.guard()` — type narrowing with type predicate
- [ ] `Composer.branch()` — true/false branches
- [ ] `Composer.branch()` — static boolean optimization
- [ ] `Composer.route()` — dispatches to correct case
- [ ] `Composer.route()` — fallback when no case matches
- [ ] `Composer.fork()` — runs in parallel, doesn't block chain
- [ ] `Composer.fork()` — errors don't affect main chain
- [ ] `Composer.tap()` — runs middleware, always continues chain
- [ ] `Composer.lazy()` — factory called per invocation
- [ ] `Composer.onError()` — catches errors from middleware chain
- [ ] `Composer.onError()` — multiple handlers: first to return non-undefined wins
- [ ] `Composer.onError()` — unhandled errors logged via console.error (no re-throw)
- [ ] `Composer.onError()` — resolves kind from registered error classes
- [ ] `Composer.onError()` — kind is undefined for unregistered errors
- [ ] `Composer.onError()` — handlers merged from extended plugins
- [ ] `Composer.group()` — middleware isolated from parent
- [ ] `Composer.group()` — parent properties visible inside group (prototype chain)
- [ ] `Composer.group()` — group derives don't leak to parent
- [ ] `Composer.extend()` — merges middleware
- [ ] `Composer.extend()` — local scope: isolated
- [ ] `Composer.extend()` — scoped: propagates one level
- [ ] `Composer.extend()` — global: propagates all levels
- [ ] `Composer.as()` — promotes all middleware to scoped/global
- [ ] Dedup — same name: second extend skipped
- [ ] Dedup — same name, different seed: both applied
- [ ] Dedup — transitive: inherited through extend chain
- [ ] `Composer.compose()` — lazy compilation, dirty flag
- [ ] `createComposer()` — returns configured class with .on()
- [ ] `.on()` — single event
- [ ] `.on()` — multiple events (array)
- [ ] `.on()` — derives visible in handler
- [ ] `.on()` — non-matching event calls next()
- [ ] `EventQueue.add()` — processes event
- [ ] `EventQueue.addBatch()` — processes all events
- [ ] `EventQueue.stop()` — waits for pending, respects timeout
- [ ] `EventQueue.onIdle()` — resolves when idle
- [ ] Cross-runtime: no setImmediate, no Node-specific APIs