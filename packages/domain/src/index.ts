export const PACKAGE_NAME = "@cashu/domain";

/** Assets module (namespaced like investments). */
export * as assets from "./assets/index.js";
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
// The investments module is reachable only through `@cashu/domain/investments`: Metro (the phone) does
// not tree-shake, so a namespace here would put all of it into every bundle that needs a primitive.
/** Loans module (namespaced like investments). */
export * as loans from "./loans/index.js";
export * from "./money.js";
export * from "./pycsv.js";
export * from "./pyJson.js";
export * from "./pyRegex.js";
export * from "./pyRepr.js";
export * from "./sha1.js";
export * from "./sha256.js";
export * from "./text.js";
