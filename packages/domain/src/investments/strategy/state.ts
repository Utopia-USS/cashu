/**
 * The state of a profile's strategy files (the pure part of `service/strategy.load`): `missing` (no
 * strategy.yaml: valuation only, no rules), `valid`, `partial` (only some rule entries have errors:
 * the other rules run, the broken ones are inactive), `invalid` (the file cannot be used). Reading the
 * files and storing versions is the caller's.
 */

import { sha256Hex } from "../../sha256.js";
import { RuleCatalog } from "../rules/catalog.js";
import type { StrategyConfig } from "./config.js";
import type { StrategyIssue, StrategyLoadResult } from "./issues.js";
import { loadStrategy } from "./loader.js";

export type StrategyStateName = "missing" | "valid" | "partial" | "invalid";

/** The profile's strategy files as read (null = the file does not exist). */
export interface StrategyFiles {
  readonly yaml: string | null;
  readonly md: string | null;
  /** `cannot read the strategy files: ...` when reading failed (then both texts are null). */
  readonly readError: string | null;
}

/** The newest stored version of the files (`inv_strategy_versions`). */
export interface StoredStrategyVersion {
  readonly version: number;
  readonly sha256: string;
}

export interface StrategyStatus {
  readonly state: StrategyStateName;
  readonly result: StrategyLoadResult | null;
  /** Digest of the current files (`_digest`), null without a strategy.yaml. */
  readonly sha256: string | null;
  /** The newest stored version (the current files when `changed` is false). */
  readonly latest: StoredStrategyVersion | null;
  /** The files differ from the newest stored version (not recorded yet). */
  readonly changed: boolean;
  readonly readError: string | null;
}

/** `_digest`: sha256 of `yaml + "\0" + md` (UTF-8). */
export function strategyDigest(yaml: string, md: string | null): string {
  return sha256Hex(`${yaml}\0${md ?? ""}`);
}

/** `service/strategy.load(..., record=False)` on files already read. */
export function strategyStatus(
  files: StrategyFiles,
  latest: StoredStrategyVersion | null,
  catalog: RuleCatalog = RuleCatalog.builtIn(),
): StrategyStatus {
  const base = { latest, changed: false, result: null, sha256: null } as const;
  if (files.readError !== null) return { ...base, state: "invalid", readError: files.readError };
  if (files.yaml === null) return { ...base, state: "missing", readError: null };
  const result = loadStrategy(files.yaml, files.md, catalog);
  const state = result.config !== null ? "valid" : result.partial !== null ? "partial" : "invalid";
  const digest = strategyDigest(files.yaml, files.md);
  return {
    state,
    result,
    sha256: digest,
    latest,
    changed: latest === null || latest.sha256 !== digest,
    readError: null,
  };
}

/** `StrategyState.config`: the usable config, the valid one or the partial one (valid rules only). */
export function usableConfig(status: StrategyStatus): StrategyConfig | null {
  return status.result === null ? null : (status.result.config ?? status.result.partial);
}

/** `issue_dict`: an issue as stored with a version and sent to the app. */
export function issueRecord(issue: StrategyIssue): Readonly<Record<string, unknown>> {
  return {
    severity: issue.severity,
    path: issue.path,
    message: issue.message,
    line: issue.line,
    column: issue.column,
    code: issue.code,
    params: { ...issue.params },
  };
}
