// Shared code runs in browsers and in Node, so it gets neither the DOM nor the
// Node typings: only these globals, which both runtimes provide. Reaching for
// anything else (document, process, Buffer...) is a compile error on purpose.
declare function setTimeout(fn: () => void, ms?: number): unknown;
declare function setInterval(fn: () => void, ms?: number): unknown;
declare function clearInterval(id: unknown): void;
declare function queueMicrotask(fn: () => void): void;
declare function structuredClone<T>(value: T): T;
declare const performance: { now(): number };
declare const console: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
