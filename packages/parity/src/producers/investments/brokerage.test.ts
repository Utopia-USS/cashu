// core.networth with the TS brokerage contributor over a synthetic dataset (invented values).

import { afterEach, describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import type { BridgeFile } from "../core/bridge.ts";
import { produceNetworth } from "../core/networth.ts";
import { dumps } from "../output.ts";

let ds: SyntheticDataset;
afterEach(() => ds.dispose());

type Tree = Record<string, unknown>;

describe("brokerage contributor in core.networth", () => {
  it("values each brokerage account from its own profile's rows, in the account currency", () => {
    ds = syntheticDataset(INVESTMENTS);
    const out = withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      const p1 = db.keys.key("profiles", 1);
      const p2 = db.keys.key("profiles", 2);
      const empty = { year_ago: "2025-10-01", modules: {} };
      const bridge: BridgeFile = { [p1]: empty, [p2]: empty };
      return {
        tree: JSON.parse(dumps(produceNetworth(db, bridge))) as Tree,
        p1,
        p2,
        broker1: db.keys.key("accounts", 1),
      };
    });
    const p1 = out.tree[out.p1] as Tree;
    const line = (p1.lines as Tree[]).find((l) => l.account_id === out.broker1) as Tree;
    // ETF 729.0 + stock 468.0 (USD at 3.9) + manual 100 + cash 4029
    expect(line.amount).toBe("5326.0");
    expect(line.as_of).toBe("2026-10-01");
    // a year before as_of nothing was held yet
    expect(p1.totals_365d_ago).toEqual({});
    // profile 2: the renamed lot at its own manual value 99, negative cash counted as 0
    expect((out.tree[out.p2] as Tree).totals).toEqual({ PLN: "99.00" });
  });
});
