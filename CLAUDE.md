# Project

`@gramio/composer` — general-purpose, type-safe middleware composition library for TypeScript.
Zero dependencies. Cross-runtime (Bun / Node.js / Deno).

## Architecture

```
src/
  types.ts      — all type definitions (including macro system types)
  compose.ts    — standalone compose() function
  composer.ts   — Composer class (core)
  factory.ts    — createComposer() factory (adds .on() event support)
  macros.ts     — buildFromOptions() runtime helper for macro execution
  queue.ts      — EventQueue (concurrent processing with graceful shutdown)
  utils.ts      — noopNext, skip, stop, nameMiddleware, cleanErrorStack utilities
  index.ts      — barrel exports
```

## Key Design Decisions

- **Four generics** on Composer: `TIn` (caller provides), `TOut` (middleware sees), `TExposed` (propagates to parent via extend), `TMacros` (registered macro definitions)
- **Nine generics** on EventComposer: `TBase`, `TEventMap`, `TIn`, `TOut`, `TExposed`, `TDerives`, `TMethods`, `TMacros`
- **Scope system** (local/scoped/global) controls derive propagation through extend chains
- **Local isolation** uses `Object.create(ctx)` — prototype chain lets reads fall through, writes stay local
- **Deduplication** by name + JSON.stringify(seed) with transitive inheritance of extended sets
- **Lazy compilation** with dirty flag — compose() caches, any mutation invalidates
- **guard() dual mode**: with handlers = side-effects (always continues); without handlers = gate (blocks chain if false). Gate mode with a type predicate narrows `TOut` for all downstream middleware (returns `EventComposer<..., TOut & Narrowing, ...>` instead of `this`)
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
- **`.on()` filter-only overload** — `on(filter, handler)` (no event name) applies the filter to all events without event discrimination. Type-narrowing predicates give the handler `ResolveEventCtx<..., CompatibleEvents<TEventMap, Narrowing>> & Narrowing` — a union of all compatible event contexts intersected with the narrowing. Boolean filters give the handler `TOut`. `CompatibleEvents<TEventMap, Narrowing>` utility type resolves which event names have all keys from `Narrowing` in their context type.
- **`.on()` 3-arg overload** — `on(event, filter, handler)` supports both type-narrowing predicates (`(ctx) => ctx is Narrowing`) and boolean filters (`(ctx) => boolean`). Filter check runs after event discrimination. The 2-arg `on(event, handler)` also accepts an optional `Patch` generic for context extensions: `on<"message", { args: string }>("message", handler)`.
- **`Patch` generic on `.use()`** — `use<Patch extends object>(handler)` lets handlers declare additional context properties not tracked in `TOut`. Useful in custom methods that enrich context before calling the handler: `use<{ args: string }>((ctx, next) => { ctx.args; })`. Does not change `TOut` — type-only escape hatch. Zero runtime overhead.
- **Custom methods** — `createComposer` accepts `methods` config for framework-specific DX sugar (e.g. `hears`, `command`). Methods are added to prototype, typed via `ThisType`. Runtime conflict check prevents accidental override of built-in methods. Phantom `types` field + `eventTypes<TEventMap>()` helper enables full type inference without explicit type parameters. **`defineComposerMethods(methods)`** helper — required for custom methods with generic signatures (TypeScript cannot infer generic methods when `TMethods` is nested inside `{ Composer: EventComposerConstructor<..., TMethods> }`). The helper returns `TMethods` directly, which preserves generic method signatures. Pass result via `typeof` as 3rd arg: `createComposer<Base, EventMap, typeof myMethods>({ methods: myMethods })`. Two patterns for derives in custom methods: (1) **`this: TThis` + `ContextOf<TThis>`** — zero annotation at call site, derives flow in automatically via TypeScript's `this` inference; (2) **`Patch` generic** — caller declares `<Patch>` at call site. Both use `(this as any).on(...)` in implementation. `ContextOf<T>` extracts `TOut` from a composer instance type via the `"~".Out` phantom field.
- **Macro system** — Elysia-inspired declarative handler options. `macro(name, def)` registers macros that consumers activate via an options object on handler methods (e.g. `command("start", handler, { throttle: { limit: 3 } })`). `MacroDef` is either a function `(opts) => MacroHooks` or a plain `MacroHooks` object (for boolean shorthand). `MacroHooks` has `preHandler` (middleware) and `derive` (context enrichment; void = stop chain). `buildFromOptions()` composes the macro chain at runtime. Execution order: `options.preHandler` → per-macro `preHandler` → per-macro `derive` → main handler. `ContextCallback` marker type + `WithCtx<T, TCtx>` recursive type enable typed callbacks in macro options (framework replaces markers with actual context type at call site). `HandlerOptions<TBaseCtx, Macros>` builds the options type, `DeriveFromOptions<Macros, TOptions>` collects derive types. `TMacros` generic propagates through `extend()`, `macro()` chains.

More about it - docs/SPEC.md

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
- `macros.test.ts` — macro system (registration, buildFromOptions, derive, preHandler)
- `types.test.ts` — compile-time type assertions (verified via `bunx tsc --noEmit`)

## Rules

- Zero dependencies — no runtime deps allowed
- No Node.js-specific APIs (no `setImmediate`, no `process.*`) — cross-runtime
- ESM-first, target ES2022+
- Use `.ts` extensions in imports (for Deno compat)
- **Always update CLAUDE.md and docs/SPEC.md** when changing API, behavior, or architecture
