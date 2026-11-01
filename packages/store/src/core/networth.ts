// The vault's net-worth inputs from the view (Python `core/networth.py` reads them through the
// session): accounts, balance snapshots and the module contributors the caller built from each
// module's `StoreModule.netWorth` source. Core never imports a module: the read models compose them.
import { core, D, type IsoDate } from "@cashu/domain";
import type { Read } from "../query.js";

interface AccountRow {
  readonly gid: string;
  readonly type: string;
  readonly currency: string;
  readonly active: number;
  readonly removedAt: string | null;
}

/**
 * The vault's accounts (removed ones too: net worth skips them) in the order the view first recorded
 * them (the fold order of their opening: Python's id order).
 */
function netWorthAccounts(read: Read): core.NetWorthAccount[] {
  return read<AccountRow>(
    `SELECT gid, type, currency, active, removed_at AS removedAt FROM accounts
     ORDER BY id`,
  ).map((a) => ({
    id: a.gid,
    type: a.type,
    currency: a.currency,
    active: a.active === 1,
    removedAt: a.removedAt,
  }));
}

/**
 * Balance snapshots per account gid, each list in the order the rows were first recorded (Python's
 * id order: a re-recorded snapshot keeps its place).
 */
function netWorthBalances(read: Read): Map<string, core.BalanceSnapshot[]> {
  const out = new Map<string, core.BalanceSnapshot[]>();
  for (const b of read<{ gid: string; date: string; amount: string; source: string }>(
    `SELECT a.gid, b.date, b.amount, b.source FROM balances b JOIN accounts a ON a.id = b.account_id
     ORDER BY b.id`,
  )) {
    const list = out.get(b.gid);
    const snap = { date: b.date, amount: D(b.amount), source: b.source };
    if (list === undefined) out.set(b.gid, [snap]);
    else list.push(snap);
  }
  return out;
}

/**
 * The vault's `NetWorthBook`: its accounts and balances with the module contributors (by module id;
 * `orderContributors` puts them in module display order, the first one valuing an account wins).
 */
export function netWorthBook(
  read: Read,
  contributors: Readonly<Record<string, core.NetWorthContributor>>,
  today: IsoDate,
  registry: core.CoreRegistry = core.builtinRegistry(),
): core.NetWorthBook {
  return {
    accounts: netWorthAccounts(read),
    balances: netWorthBalances(read),
    contributors: core.orderContributors(registry, contributors),
    types: registry.accountTypes,
    today,
  };
}
