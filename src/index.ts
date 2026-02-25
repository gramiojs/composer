// Core
export { compose } from "./compose.ts";
export { Composer, type RouteHandler, type RouteBuilder } from "./composer.ts";
export { createComposer, eventTypes, defineComposerMethods } from "./factory.ts";
export type { EventComposer, EventComposerConstructor, CompatibleEvents, ContextOf, ComposerLike } from "./factory.ts";
export { EventQueue } from "./queue.ts";
export { buildFromOptions } from "./macros.ts";

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
	MiddlewareType,
	MiddlewareInfo,
	TraceHandler,
	ComposerOptions,
	// Macro system
	ContextCallback,
	WithCtx,
	MacroHooks,
	MacroDef,
	MacroDefinitions,
	MacroOptionType,
	MacroDeriveType,
	HandlerOptions,
	DeriveFromOptions,
} from "./types.ts";

// Utilities
export { noopNext, skip, stop } from "./utils.ts";
