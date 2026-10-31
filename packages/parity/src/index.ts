export const PACKAGE_NAME = "@cashu/parity";

export type { CompareOptions, Diff, DiffKind } from "./compare.ts";
export { compare, DEFAULT_OPTIONS, floatsEqual, pathKey } from "./compare.ts";
export type { CheckOverride, ParityConfig } from "./config.ts";
export { loadConfig, optionsFor, parseConfig } from "./config.ts";
export type { DecimalPolicy } from "./decimal.ts";
export { decimalsEqual, isDecimalString } from "./decimal.ts";
export type { CanonObject, CanonValue } from "./json.ts";
export { CanonParseError, canonType, parseCanonical, sha256Hex } from "./json.ts";
export { formatReport, reportToJson } from "./report.ts";
export type { CheckReport, Report, RunOptions, Status } from "./run.ts";
export { goldenChecks, runParity } from "./run.ts";
