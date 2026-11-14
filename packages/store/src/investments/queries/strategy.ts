// Strategy versions (Python `service/strategy.py` `latest_version` / `versions`, read side). Numbers
// and "current" are DERIVED from the fold order (events.md 8.8): the current version is the highest
// `version`.
import type { StrategyStateName } from "@cashu/domain/investments/strategy";
import { jsonList, type Read } from "./shared.js";

/** One stored version of the strategy files (`inv_strategy_versions`). */
export interface StrategyVersionView {
  readonly gid: string;
  readonly version: number;
  readonly sha256: string;
  readonly yamlText: string;
  readonly mdText: string | null;
  /** A stored version is never `missing` (no strategy.yaml means nothing to store). */
  readonly state: Exclude<StrategyStateName, "missing">;
  /** Python `issue_dict` records (severity, path, message, line, column, code, params). */
  readonly issues: readonly Readonly<Record<string, unknown>>[];
  readonly createdAt: string;
}

interface Row {
  gid: string;
  version: number;
  sha256: string;
  yamlText: string;
  mdText: string | null;
  state: Exclude<StrategyStateName, "missing">;
  issues: string;
  createdAt: string;
}

const SQL = `SELECT gid, version, sha256, yaml_text AS yamlText, md_text AS mdText, state, issues,
  created_at AS createdAt FROM inv_strategy_versions`;

function toView(r: Row): StrategyVersionView {
  return {
    ...r,
    issues: jsonList(r.issues).map((i) => {
      if (typeof i !== "object" || i === null || Array.isArray(i)) {
        throw new RangeError("a strategy issue is not an object");
      }
      return { ...i };
    }),
  };
}

/** Python `latest_version`: the current (highest) version, undefined before the first one. */
export function latestStrategyVersion(read: Read): StrategyVersionView | undefined {
  const row = read<Row>(`${SQL} ORDER BY version DESC LIMIT 1`)[0];
  return row === undefined ? undefined : toView(row);
}

/** Python `versions`: every stored version, newest first. */
export function strategyVersions(read: Read): StrategyVersionView[] {
  return read<Row>(`${SQL} ORDER BY version DESC`).map(toView);
}

/** A version's place in the edit history: what it was edited on top of (events.md 8.8). */
export interface StrategyVersionLink {
  readonly gid: string;
  readonly sha256: string;
  /** False for a version recorded before base tracking: its base is unknown. */
  readonly baseKnown: boolean;
  /** The version it was edited on top of; null = none was recorded yet. */
  readonly base: string | null;
}

/** The stored version `gid` (undefined when no row has it: unknown, or dropped as a duplicate). */
export function strategyVersionLink(read: Read, gid: string): StrategyVersionLink | undefined {
  const row = read<{ gid: string; sha256: string; base: string | null; baseKnown: number }>(
    `SELECT gid, sha256, base_gid AS base, base_known AS baseKnown FROM inv_strategy_versions
     WHERE gid = ?`,
    gid,
  )[0];
  return row === undefined
    ? undefined
    : { gid: row.gid, sha256: row.sha256, base: row.base, baseKnown: row.baseKnown === 1 };
}

/** The newest stored version whose text has digest `sha256` (a revert can repeat an older one). */
export function strategyVersionWithSha(read: Read, sha256: string): string | undefined {
  return read<{ gid: string }>(
    "SELECT gid FROM inv_strategy_versions WHERE sha256 = ? ORDER BY version DESC LIMIT 1",
    sha256,
  )[0]?.gid;
}

/**
 * Whether `ancestor` is in the edit history `version` was built on (walking `base` links). An
 * unknown link (a version from before base tracking, or a base no row has) answers true: only a
 * known history can show that a version was recorded without seeing `ancestor`.
 */
export function strategyVersionBuiltOn(read: Read, version: string, ancestor: string): boolean {
  let current: string | null = version;
  for (let steps = 0; current !== null && steps < 100_000; steps++) {
    if (current === ancestor) return true;
    const link = strategyVersionLink(read, current);
    if (link === undefined || !link.baseKnown) return true;
    current = link.base;
  }
  return current !== null;
}
