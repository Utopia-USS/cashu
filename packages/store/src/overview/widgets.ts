// Read-only S55b Overview facts from one vault. Display and navigation stay in the screen layer.
import { assets, budget, core, D, type Decimal, type IsoDate } from "@cashu/domain";
import { budgetBook } from "../budget/read-models.js";
import { defineQuery, type Read } from "../query.js";

export interface OverviewAccount {
  readonly gid: string;
  readonly name: string;
  readonly bank: string;
  readonly type: string;
  readonly currency: string;
  readonly ibanTail: string | null;
  readonly amount: Decimal | null;
  readonly asOf: IsoDate | null;
  readonly liability: boolean;
}

/** The visible account rows use the same valued book as the hero, including cash/loans/assets. */
export function overviewAccounts(read: Read, book: core.NetWorthBook): OverviewAccount[] {
  const metadata = new Map(
    read<{
      gid: string;
      name: string;
      bank: string;
      iban: string | null;
    }>("SELECT gid, name, bank, iban FROM accounts ORDER BY id").map((row) => [row.gid, row]),
  );
  return core.netWorth(book).lines.map((line) => {
    const meta = metadata.get(line.account.id);
    return {
      gid: line.account.id,
      name: meta?.name ?? "",
      bank: meta?.bank ?? "",
      type: line.account.type,
      currency: line.account.currency,
      ibanTail: meta?.iban?.slice(-4) ?? null,
      amount: line.amount,
      asOf: line.asOf,
      liability: line.isLiability,
    };
  });
}

export interface CashWalletRow {
  readonly gid: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly title: string | null;
  readonly category: string | null;
  readonly kind: "withdrawal" | "expense";
}

export interface CashWalletView {
  readonly exists: boolean;
  readonly currency: string;
  readonly balance: Decimal;
  readonly withdrawals: Decimal;
  readonly expenses: Decimal;
  readonly transactions: readonly CashWalletRow[];
}

/** The cash drawer's own native rows; actions address their opaque gids. */
export function cashWallet(read: Read, currency?: string | null): CashWalletView {
  const book = budgetBook(read);
  const selected = currency || book.baseCurrency;
  const account = book.accounts.find(
    (row) =>
      row.type === budget.CASH_ACCOUNT_TYPE && row.currency === selected && row.removedAt === null,
  );
  const rows = book.transactions
    .filter((row) => row.account === account?.id)
    .map(
      (row): CashWalletRow => ({
        gid: row.key,
        date: row.bookingDate,
        amount: row.amount,
        title: row.reference || row.description || row.counterpartyName,
        category: row.category,
        kind: row.amount.gt(D("0")) ? "withdrawal" : "expense",
      }),
    )
    .toReversed()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  let balance = D("0");
  let withdrawals = D("0");
  let expenses = D("0");
  for (const row of rows) {
    balance = balance.add(row.amount);
    if (row.amount.gt(D("0"))) withdrawals = withdrawals.add(row.amount);
    else if (row.amount.lt(D("0"))) expenses = expenses.sub(row.amount);
  }
  return {
    exists: account !== undefined,
    currency: selected,
    balance,
    withdrawals,
    expenses,
    transactions: rows,
  };
}

export const overviewCashWallet = defineQuery({
  id: "core.overviewCashWallet",
  run: (read, args: { readonly currency?: string | null }) => cashWallet(read, args.currency),
});

export interface OverviewAsset extends OverviewAccount {
  readonly kind: "manual" | "vehicle";
  readonly note: string | null;
  readonly depreciation: {
    readonly purchasePrice: Decimal;
    readonly purchaseDate: IsoDate;
    readonly annualRate: Decimal;
    readonly floor: Decimal | null;
  } | null;
}

/** The manual assets drawer sees the same computed valuations as the hero. */
export function overviewAssets(read: Read, book: core.NetWorthBook): OverviewAsset[] {
  const rows = read<{
    gid: string;
    externalId: string | null;
    note: string | null;
    purchasePrice: string | null;
    purchaseDate: IsoDate | null;
    annualRate: string | null;
    floor: string | null;
  }>(`SELECT a.gid, a.external_id AS externalId, d.note, v.purchase_price AS purchasePrice,
            v.purchase_date AS purchaseDate, v.annual_rate AS annualRate, v.floor
       FROM accounts a
       LEFT JOIN asset_details d ON d.account_id = a.id
       LEFT JOIN depreciations v ON v.account_id = a.id
       WHERE a.bank = 'manual' AND a.removed_at IS NULL ORDER BY a.id`);
  const metadata = new Map(rows.map((row) => [row.gid, row]));
  return overviewAccounts(read, book)
    .filter((account) => {
      const detail = metadata.get(account.gid);
      return (
        !account.liability &&
        detail !== undefined &&
        assets.isModuleAccount({ bank: account.bank, externalId: detail.externalId })
      );
    })
    .map((account) => {
      const detail = metadata.get(account.gid);
      return {
        ...account,
        kind: assets.isVehicle({ externalId: detail?.externalId ?? null })
          ? ("vehicle" as const)
          : ("manual" as const),
        note: detail?.note ?? null,
        depreciation:
          detail?.purchasePrice === null ||
          detail?.purchasePrice === undefined ||
          detail.purchaseDate === null ||
          detail.annualRate === null
            ? null
            : {
                purchasePrice: D(detail.purchasePrice),
                purchaseDate: detail.purchaseDate,
                annualRate: D(detail.annualRate),
                floor: detail.floor === null ? null : D(detail.floor),
              },
      };
    })
    .sort((a, b) => {
      const left = a.amount?.abs() ?? D("0");
      const right = b.amount?.abs() ?? D("0");
      if (!left.eq(right)) return right.gt(left) ? 1 : -1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}
