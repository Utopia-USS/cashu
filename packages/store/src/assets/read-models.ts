// Assets reads for the overview and the blank page: the vehicles' net-worth source (Python
// `assets/networth.py`: the depreciation curve) and the setup facts (`assets/setup.py`).
import { assets, D, type IsoDate } from "@cashu/domain";
import type { Read } from "../query.js";
import type { NetWorthSource, SetupSource } from "../registry.js";

/** The vault's depreciation curves, oldest first. */
function depreciationTerms(read: Read): assets.DepreciationTerms[] {
  return read<{
    account: string;
    purchasePrice: string;
    purchaseDate: IsoDate;
    annualRate: string;
    floor: string | null;
  }>(
    `SELECT a.gid AS account, d.purchase_price AS purchasePrice, d.purchase_date AS purchaseDate,
       d.annual_rate AS annualRate, d.floor
     FROM depreciations d JOIN accounts a ON a.id = d.account_id ORDER BY d.id`,
  ).map((d) => ({
    accountId: d.account,
    purchasePrice: D(d.purchasePrice),
    purchaseDate: d.purchaseDate,
    annualRate: D(d.annualRate),
    floor: d.floor === null ? null : D(d.floor),
  }));
}

export const assetsNetWorth: NetWorthSource = (read) =>
  assets.assetsContributor(depreciationTerms(read));

/** The facts behind the assets steps (Python `setup_status`); a removed position never counts. */
function assetsSetupFacts(read: Read): assets.AssetsSetupFacts {
  const types = assets.SETUP_POSITION_TYPES;
  const row = read<{ positions: number; vehicles: number; depreciating: number }>(
    `SELECT count(*) AS positions,
       coalesce(sum(a.type = 'vehicle'), 0) AS vehicles,
       coalesce(sum(a.type = 'vehicle' AND d.account_id IS NOT NULL), 0) AS depreciating
     FROM accounts a LEFT JOIN depreciations d ON d.account_id = a.id
     WHERE a.removed_at IS NULL AND a.type IN (${types.map(() => "?").join(", ")})`,
    ...types,
  )[0];
  return {
    positions: row?.positions ?? 0,
    vehicles: row?.vehicles ?? 0,
    depreciatingVehicles: row?.depreciating ?? 0,
  };
}

export const assetsSetup: SetupSource = (read, ctx) =>
  assets.assetsSetupSteps(assetsSetupFacts(read), ctx);
