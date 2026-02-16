# Project

`@gramio/composer` — general-purpose, type-safe middleware composition library for TypeScript.
Zero dependencies. Cross-runtime (Bun / Node.js / Deno).

## Architecture

```
src/
  types.ts      — all type definitions
  compose.ts    — standalone compose() function
  composer.ts   — Composer class (core)
  factory.ts    — createComposer() factory (adds .on() event support)
  queue.ts      — EventQueue (concurrent processing with graceful shutdown)
  utils.ts      — noopNext, skip, stop, nameMiddleware, cleanErrorStack utilities
  index.ts      — barrel exports
```

## Key Design Decisions

- **Three generics** on Composer: `TIn` (caller provides), `TOut` (middleware sees), `TExposed` (propagates to parent via extend)
- **Scope system** (local/scoped/global) controls derive propagation through extend chains
- **Local isolation** uses `Object.create(ctx)` — prototype chain lets reads fall through, writes stay local
- **Deduplication** by name + JSON.stringify(seed) with transitive inheritance of extended sets
- **Lazy compilation** with dirty flag — compose() caches, any mutation invalidates
- **guard() dual mode**: with handlers = side-effects (always continues); without handlers = gate (blocks chain if false)
- **`_` / `"~"` internals** — all internal state lives on `_` object, `"~"` is alias. Access via `composer["~"].middlewares` etc. Pushes internals to end of IDE autocomplete
- **Event-specific derive** — EventComposer supports `derive(event, handler)` for per-event context enrichment
- **Error system (Elysia-style)** — `error(kind, class)` registers error kinds, `onError(handler)` pushes to `["~"].onErrors` array. On error: handlers iterated in order, first to return non-undefined wins, unhandled errors logged via `console.error` (no re-throw, no crash). `extend()` merges both `errorsDefinitions` and `onErrors`. Handler receives `{ error, context, kind? }` where `kind` is resolved via `instanceof` against registered classes
- **route() dual mode** — record mode (`cases` object) for simple dispatch; builder mode (`(route) => { route.on(...) }`) for composable routes with derive/guard per case. Router function may return `undefined` (→ fallback). Record mode accepts `Middleware`, `Middleware[]`, or `Composer` as case values. Builder's `route.on(key)` returns a pre-typed Composer.
- **decorate()** — static context enrichment without function call overhead. Same scope system as derive() (local/scoped/global). Unlike derive(), takes a plain object instead of a handler function — no per-request computation.
- **when()** — conditional middleware registration at build time. `when(condition, fn)` applies fn's middleware only if condition is true. Types from conditional block are `Partial` (optional) since the block may not execute. Propagates dedup keys, error handlers, and error definitions from the conditional block.
- **Observability** — every `ScopedMiddleware` carries `type` (which method created it) and `name` (original handler function name). Wrapper functions are named via `Object.defineProperty(fn, 'name')` for meaningful stack traces. Format: `type:handlerName` (e.g. `derive:getUser`, `guard:isAdmin`, `on:message`).
- **trace()** — opt-in hook for external instrumentation. Sets a `TraceHandler` callback. At `compose()` time, if tracer is set, each middleware is wrapped with enter/exit instrumentation. Zero overhead when not used.
- **inspect()** — returns `MiddlewareInfo[]` with `{ index, type, name, scope, plugin? }` for each registered middleware. Read-only projection of internal state.
- **Clean stack traces** — `compose()` error handler strips library-internal frames from `error.stack` before passing to `onError` handlers and `console.error`. Uses `import.meta.url` to detect the library's source directory at load time. Users only see their own code in stack traces.

More about it - @docs/SPEC.md

## Commands

- `bun test` — run all tests
- `bun run lint` — lint source
- `bunx tsc --noEmit` — type-check
- `bunx pkgroll` — build for publish

## Testing

Tests live in `tests/` directory using `bun:test`. Test files mirror source structure:

- `compose.test.ts` — standalone compose function
- `composer.test.ts` — Composer class methods
- `scope.test.ts` — scope system (local/scoped/global)
- `dedup.test.ts` — plugin deduplication
- `factory.test.ts` — createComposer + EventComposer .on()
- `queue.test.ts` — EventQueue
- `utils.test.ts` — utility functions
- `observability.test.ts` — function naming, inspect(), trace(), stack traces
- `types.test.ts` — compile-time type assertions (verified via `bunx tsc --noEmit`)

## Rules

- Zero dependencies — no runtime deps allowed
- No Node.js-specific APIs (no `setImmediate`, no `process.*`) — cross-runtime
- ESM-first, target ES2022+
- Use `.ts` extensions in imports (for Deno compat)
- **Always update CLAUDE.md and docs/SPEC.md** when changing API, behavior, or architecture
