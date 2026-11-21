/**
 * Public entry point of the investments module of `@cashu/domain`. Importing and macro have their own
 * subpaths (`@cashu/domain/investments/importing`, `.../macro`) instead of namespaces here, and so do
 * alerts, performance, plan, research and views (`.../alerts`, `.../performance`, `.../plan`,
 * `.../research`, `.../views`; their types stay reachable here): the store's fold and the phone never
 * need them, and a bundler without tree shaking (Metro) carries everything an index re-exports. The
 * research bounds the fold shares come from `.../research/contract` alone.
 */

export type * as alerts from "./alerts/index.js";
export * from "./domain/index.js";
export * as market from "./market/index.js";
export * from "./networth.js";
export type * as performance from "./performance/index.js";
export type * as plan from "./plan/index.js";
export * from "./portfolio/index.js";
export type * as research from "./research/index.js";
export * from "./setup.js";
export * from "./setup.strings.js";
export type * as views from "./views/index.js";
