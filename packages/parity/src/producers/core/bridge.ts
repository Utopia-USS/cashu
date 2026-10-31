/// <reference types="node" />
/**
 * TRANSITIONAL(S11): reader of the temporary Python bridge (`networth_bridge.py`): the net-worth values of the module
 * contributors not ported to TS yet (loans, assets: S11), replayed as
 * `NetWorthContributor`s. Each answers `latest()` only for the two dates `core.networth` asks
 * ("now" and as_of - 365 days); the history series would need more (`at`, `axisDates`) and throws.
 * A module leaves the bridge when its TS contributor lands.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, type core, D, type Decimal, type IsoDate } from "@cashu/domain";
import { type Dataset, labRoot } from "../../sources/index.ts";

const BRIDGE_CHECK = "core.networth_contributors";
const BRIDGED_MODULES = ["loans", "assets"] as const;

interface BridgeEntry {
  readonly as_of: string;
  readonly amount: string;
}
interface BridgeValues {
  readonly now: BridgeEntry | null;
  readonly year_ago: BridgeEntry | null;
}
interface BridgeProfile {
  readonly year_ago: string;
  readonly modules: Readonly<Record<string, Readonly<Record<string, BridgeValues>>>>;
}
export type BridgeFile = Readonly<Record<string, BridgeProfile>>;

function bridgePath(dataset: Dataset, root: string = labRoot()): string {
  return join(root, "parity", "bridge", dataset, `${BRIDGE_CHECK}.json`);
}

export function readBridge(dataset: Dataset, root?: string): BridgeFile {
  const path = bridgePath(dataset, root);
  if (!existsSync(path)) {
    throw new Error(
      `no bridge output for ${dataset}: run .venv/bin/python packages/parity/src/producers/core/networth_bridge.py --dataset ${dataset}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as BridgeFile;
}

class BridgedValuation implements core.Valuation {
  private readonly values: BridgeValues;
  private readonly yearAgo: IsoDate;

  constructor(values: BridgeValues, yearAgo: IsoDate) {
    this.values = values;
    this.yearAgo = yearAgo;
  }

  latest(asOf: IsoDate | null, _today: IsoDate): core.LatestEntry | null {
    let entry: BridgeEntry | null;
    if (asOf === null) entry = this.values.now;
    else if (asOf === this.yearAgo) entry = this.values.year_ago;
    else throw new Error("the bridge holds values for now and as_of - 365 days only");
    return entry === null ? null : [entry.as_of, D(entry.amount)];
  }

  at(_d: IsoDate): Decimal | null {
    throw new Error("the bridge holds no history (net worth series needs the TS contributor)");
  }

  axisDates(): IsoDate[] {
    throw new Error("the bridge holds no history (net worth series needs the TS contributor)");
  }
}

/** A module's bridged contributor: values exactly the accounts Python's contributor valued. */
class BridgedContributor implements core.NetWorthContributor {
  private readonly byAccount: ReadonlyMap<string, BridgedValuation>;

  constructor(byAccount: ReadonlyMap<string, BridgedValuation>) {
    this.byAccount = byAccount;
  }

  valuations(
    accounts: ReadonlyMap<string, core.NetWorthAccount>,
  ): ReadonlyMap<string, core.Valuation> {
    const out = new Map<string, core.Valuation>();
    for (const [id, v] of this.byAccount) if (accounts.has(id)) out.set(id, v);
    return out;
  }
}

/** The bridged contributors of one profile, by module id. */
export function bridgedContributors(
  bridge: BridgeFile,
  profileKey: string,
  asOf: IsoDate,
): Record<string, core.NetWorthContributor> {
  const profile = bridge[profileKey];
  if (profile === undefined) throw new Error("the bridge has no entry for a dataset profile");
  const yearAgo = addDays(asOf, -365);
  if (profile.year_ago !== yearAgo) throw new Error("the bridge was made for another as_of");
  const out: Record<string, core.NetWorthContributor> = {};
  for (const module of BRIDGED_MODULES) {
    const values = profile.modules[module] ?? {};
    const byAccount = new Map(
      Object.entries(values).map(([id, v]) => [id, new BridgedValuation(v, yearAgo)]),
    );
    out[module] = new BridgedContributor(byAccount);
  }
  return out;
}
