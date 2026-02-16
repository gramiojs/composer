// Core
export { compose } from "./compose.ts";
export { Composer } from "./composer.ts";
export { createComposer } from "./factory.ts";
export type { EventComposer, EventComposerConstructor } from "./factory.ts";
export { EventQueue } from "./queue.ts";

// Types
export type {
	Next,
	Middleware,
	ComposedMiddleware,
	ErrorHandler,
	DeriveHandler,
	LazyFactory,
	MaybeArray,
	Scope,
	ComposerOptions,
} from "./types.ts";

// Utilities
export { noopNext, skip, stop } from "./utils.ts";
