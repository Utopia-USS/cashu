// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// The completeness guard's data (S31a spec 4.4, lead decision: coverage guard (b)): every table the
// bridge maps, who fills its gid, every Python column with the event types that carry a change of it
// (or why it is not shipped), and the ops it handles. `coverage.json` is this table, committed;
// `coverage.test.ts` keeps it equal to the code and `tests/test_bridge_coverage.py` checks Python's
// `sync_outbox.SPECS` against it, so a new Python column or explicit op fails the build until it is
// classified here.
import { BRIDGES } from "./map.js";

export interface TableCoverage {
  readonly gid: string;
  /** Column -> carrying event types, or `"not shipped: <reason>"`. */
  readonly columns: Readonly<Record<string, readonly string[] | string>>;
  readonly ops: readonly string[];
}

export interface Coverage {
  readonly format: 1;
  readonly tables: Readonly<Record<string, TableCoverage>>;
}

/** The coverage table of the bridges in code, keys sorted (the committed JSON's form). */
export function coverage(): Coverage {
  const tables: Record<string, TableCoverage> = {};
  for (const name of [...BRIDGES.keys()].sort()) {
    const b = BRIDGES.get(name);
    if (b === undefined) continue;
    const columns: Record<string, readonly string[] | string> = {};
    for (const col of Object.keys(b.columns).sort()) {
      const rule = b.columns[col];
      if (rule === undefined) continue;
      columns[col] =
        "carriedBy" in rule ? [...rule.carriedBy].sort() : `not shipped: ${rule.notShipped}`;
    }
    const ops = [
      ...(b.insert ? ["insert"] : []),
      ...(b.update ? ["update"] : []),
      ...(b.delete ? ["delete"] : []),
      ...Object.keys(b.explicit ?? {}).sort(),
    ];
    tables[name] = { gid: b.gid, columns, ops };
  }
  return { format: 1, tables };
}
