export const PACKAGE_NAME = "@cashu/domain";

/** Budget module (namespaced like investments). */
export * as budget from "./budget/index.js";
export * from "./casefold.js";
export * from "./codecs.js";
/** Core module (registries, net worth, profile rules). */
export * as core from "./core/index.js";
export * from "./dates.js";
export * from "./decimal.js";
export * from "./difflib.js";
export * from "./iban.js";
/** Investments module (namespaced: its names would collide with other modules', e.g. `Transaction`). */
export * as investments from "./investments/index.js";
export * from "./money.js";
export * from "./pycsv.js";
export * from "./pyJson.js";
export * from "./pyRegex.js";
export * from "./pyRepr.js";
export * from "./sha1.js";
export * from "./sha256.js";
export * from "./text.js";
