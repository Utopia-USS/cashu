/**
 * Macro regime cards, pure part (`investments/macro`): the reference series, the five regimes with
 * hysteresis, their card texts (catalog `macro.strings.ts`, Polish and English), the API card shape,
 * the digest's regime switches and the refresh over an injected chart source. Reading and writing the
 * stored closes, the evaluation cache and the daily refresh wiring need the store (S22a / S22c).
 */

export * from "./format.js";
export * from "./macro.strings.js";
export * from "./refresh.js";
export * from "./regimes.js";
export * from "./series.js";
export * from "./service.js";
export * from "./texts.js";
