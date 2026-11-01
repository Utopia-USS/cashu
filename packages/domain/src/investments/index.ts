/**
 * Public entry point of the investments module of `@cashu/domain`. Importing and macro have their own
 * subpaths (`@cashu/domain/investments/importing`, `.../macro`) instead of namespaces here: the store
 * and the phone never need them, and a bundler without tree shaking (Metro) carries everything an
 * index re-exports.
 */

export * as alerts from "./alerts/index.js";
export * from "./dedupKey.js";
export * from "./domain/index.js";
export * as market from "./market/index.js";
export * from "./networth.js";
export * as performance from "./performance/index.js";
export * as plan from "./plan/index.js";
export * from "./portfolio/index.js";
export * as research from "./research/index.js";
export * from "./setup.js";
export * from "./setup.strings.js";
