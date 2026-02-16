@docs/SPEC.md

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
  utils.ts      — noopNext, skip, stop utilities
  index.ts      — barrel exports
```

## Key Design Decisions

- **Three generics** on Composer: `TIn` (caller provides), `TOut` (middleware sees), `TExposed` (propagates to parent via extend)
- **Scope system** (local/scoped/global) controls derive propagation through extend chains
- **Local isolation** uses `Object.create(ctx)` — prototype chain lets reads fall through, writes stay local
- **Deduplication** by name + JSON.stringify(seed) with transitive inheritance of extended sets
- **Lazy compilation** with dirty flag — compose() caches, any mutation invalidates
- **guard() dual mode**: with handlers = side-effects (always continues); without handlers = gate (blocks chain if false)

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
- `types.test.ts` — compile-time type assertions (verified via `bunx tsc --noEmit`)

## Rules

- Zero dependencies — no runtime deps allowed
- No Node.js-specific APIs (no `setImmediate`, no `process.*`) — cross-runtime
- ESM-first, target ES2022+
- Use `.ts` extensions in imports (for Deno compat)
