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
