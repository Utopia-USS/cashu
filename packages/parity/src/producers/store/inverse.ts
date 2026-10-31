/**
 * TRANSITIONAL(S24) / TRANSITIONAL(S25): inverse mode of the genesis roundtrip (S26 spec 8.3
 * `inverse.ts`): the genesis events of a table that has no materializer yet -> source-shaped canonical
 * rows, one per row gid. Each builder reads its events the way the table's fold (events.md 8) will:
 * a column takes its value from the event that sets it, timestamps through the domain time
 * (`stamps[column]`, else the payload's explicit time, else `at`, events.md 4.4), references through
 * the vault's gid map (`GidKeys`). A table flips to view mode when its materializer lands (S24: core,
 * budget, loans, assets rows; S25: investments, journal, research, agent rows) and its builder is
 * deleted; the golden must still pass.
 *
 * This file: the framework and the core / budget / loans / assets / agent tables;
 * `inverseInvestments.ts`: the investments, journal, signals and research tables.
 */

import type { OutValue } from "../output.ts";
import { bool, type CanonRow, int, json, text, timestamp } from "./canonical.ts";
import type { GenesisEvent } from "./genesisRun.ts";
import type { GidKeys } from "./gidKeys.ts";
import type { GidRow } from "./project.ts";

/** The events of one row gid, in log order. */
export type RowEventsOf = readonly GenesisEvent[];

export interface InverseSpec {
  /** Event types of the table (only these are read). */
  readonly types: readonly string[];
  /** Rows of all row gids (in first-event order), or undefined for a gid that yields no row. */
  readonly rows: (groups: readonly RowEventsOf[], keys: GidKeys) => GidRow[];
}

export class InverseError extends Error {
  constructor(table: string, what: string) {
    super(`store.table.${table} inverse: ${what}`);
    this.name = "InverseError";
  }
}

// --------------------------------------------------------------------------- value readers

const stampsOf = (e: GenesisEvent) =>
  (e.data.stamps ?? {}) as Readonly<Record<string, string | null | undefined>>;

/** A stamped column of `e` only (a nullable column the event does not set by itself). */
export function stamp(e: GenesisEvent, column: string): string | null {
  return timestamp(stampsOf(e)[column] ?? null);
}

/** The domain time of `column` at `e` (events.md 4.4): stamp, else `explicit`, else `at`. */
export function time(e: GenesisEvent, column: string, explicit?: unknown): string | null {
  const stamped = stampsOf(e)[column];
  if (stamped !== null && stamped !== undefined) return timestamp(stamped);
  if (explicit !== null && explicit !== undefined) return timestamp(explicit);
  return timestamp(e.at);
}

/** A nullable explicit time of the payload, the stamp first (genesis stamps every row column). */
export function maybeTime(e: GenesisEvent, column: string, explicit: unknown): string | null {
  return stamp(e, column) ?? timestamp(explicit ?? null);
}

/** Field readers over one event's payload. */
export function fields(e: GenesisEvent, keys: GidKeys) {
  const d = e.data;
  return {
    text: (k: string) => text(d[k]),
    int: (k: string) => int(d[k]),
    bool: (k: string) => bool(d[k]),
    json: (k: string): OutValue => json(d[k], keys.mapString),
    ref: (table: string, k: string) => keys.ref(table, d[k]),
  };
}

const ofType = (events: RowEventsOf, type: string) => events.filter((e) => e.type === type);

/** The first event of `type`, which every row of the table has. */
export function first(table: string, events: RowEventsOf, type: string): GenesisEvent {
  const e = events.find((x) => x.type === type);
  if (e === undefined) throw new InverseError(table, `a row without ${type}`);
  return e;
}

export function last(events: RowEventsOf): GenesisEvent {
  const e = events[events.length - 1];
  if (e === undefined) throw new InverseError("?", "a row without events");
  return e;
}

export const lastOf = (events: RowEventsOf, type: string): GenesisEvent | undefined =>
  ofType(events, type).at(-1);

/** One row per gid group (`build` returns undefined to leave a gid out). */
export function perGid(
  build: (events: RowEventsOf, keys: GidKeys) => CanonRow | undefined,
): InverseSpec["rows"] {
  return (groups, keys) =>
    groups.flatMap((events) => {
      const row = build(events, keys);
      return row === undefined ? [] : [{ gid: last(events).gid, row }];
    });
}

// --------------------------------------------------------------------------- core, budget, assets, loans, agent

const profiles: InverseSpec = {
  types: ["profile.created"],
  rows: perGid((events, keys) => {
    const e = first("profiles", events, "profile.created");
    const f = fields(e, keys);
    return {
      slug: f.text("slug"),
      name: f.text("name"),
      base_currency: f.text("baseCurrency"),
      mcp_privacy: f.text("mcpPrivacy"),
      created_at: time(e, "created_at"),
    };
  }),
};

const profileModules: InverseSpec = {
  types: ["module.enabled", "module.disabled"],
  rows: perGid((events, keys) => {
    const e = last(events);
    return {
      module_id: fields(first("profile_modules", events, "module.enabled"), keys).text("moduleId"),
      enabled: e.type === "module.enabled",
      enabled_at: time(e, "enabled_at"),
    };
  }),
};

const balances: InverseSpec = {
  types: ["balance.recorded"],
  rows: perGid((events, keys) => {
    const e = first("balances", events, "balance.recorded");
    const f = fields(e, keys);
    return {
      account_id: f.ref("accounts", "account"),
      date: f.text("date"),
      amount: f.text("amount"),
      currency: f.text("currency"),
      source: f.text("source"),
      created_at: time(e, "created_at"),
    };
  }),
};

const importBatches: InverseSpec = {
  types: ["importBatch.recorded"],
  rows: perGid((events, keys) => {
    const e = first("import_batches", events, "importBatch.recorded");
    const f = fields(e, keys);
    return {
      source: f.text("source"),
      bank: f.text("bank"),
      account_id: f.ref("accounts", "account"),
      filename: f.text("filename"),
      started_at: time(e, "started_at", e.data.startedAt),
      finished_at: maybeTime(e, "finished_at", e.data.finishedAt),
      num_seen: f.int("numSeen"),
      num_inserted: f.int("numInserted"),
      num_duplicates: f.int("numDuplicates"),
      notes: f.text("notes"),
    };
  }),
};

/**
 * TRANSITIONAL(S24): the cash expenses of the `transactions` table (`txn.cashExpenseAdded`, no
 * materializer before S24), shaped as Python's `cash.add_cash_expense` stores them.
 */
export const cashExpenses: InverseSpec = {
  types: ["txn.cashExpenseAdded"],
  rows: perGid((events, keys) => {
    const e = first("transactions", events, "txn.cashExpenseAdded");
    const f = fields(e, keys);
    const title = f.text("title");
    return {
      account_id: f.ref("accounts", "account"),
      booking_date: f.text("bookingDate"),
      value_date: null,
      amount: f.text("amount"),
      currency: f.text("currency"),
      counterparty_name: title,
      counterparty_iban: null,
      description: title,
      reference: title,
      bank_transaction_id: null,
      source: "manual",
      occurrence: 0n,
      category: f.text("category"),
      category_source: "manual_txn",
      raw: { cash_expense: true },
      import_batch_id: null,
      created_at: time(e, "created_at"),
    };
  }),
};

const loans: InverseSpec = {
  types: ["loan.termsSet", "loan.paymentMatchingSet"],
  rows: perGid((events, keys) => {
    const terms = lastOf(events, "loan.termsSet") ?? first("loans", events, "loan.termsSet");
    const matching = lastOf(events, "loan.paymentMatchingSet");
    const f = fields(terms, keys);
    const m = matching === undefined ? undefined : fields(matching, keys);
    return {
      account_id: f.ref("accounts", "account"),
      principal: f.text("principal"),
      annual_rate: f.text("annualRate"),
      term_months: f.int("termMonths"),
      start_date: f.text("startDate"),
      origination_date: f.text("originationDate"),
      created_at: time(events[0] as GenesisEvent, "created_at"),
      updated_at: time(last(events), "updated_at"),
      payment_iban: m?.text("paymentIban") ?? null,
      payment_text: m?.text("paymentText") ?? null,
    };
  }),
};

const depreciations: InverseSpec = {
  types: ["depreciation.set"],
  rows: perGid((events, keys) => {
    const e = last(events);
    const f = fields(e, keys);
    return {
      account_id: f.ref("accounts", "account"),
      purchase_price: f.text("purchasePrice"),
      purchase_date: f.text("purchaseDate"),
      annual_rate: f.text("annualRate"),
      floor: f.text("floor"),
      created_at: time(events[0] as GenesisEvent, "created_at"),
    };
  }),
};

const assetDetails: InverseSpec = {
  types: ["assetDetails.noteSet"],
  rows: perGid((events, keys) => {
    const e = last(events);
    const f = fields(e, keys);
    return {
      account_id: f.ref("accounts", "account"),
      note: f.text("note"),
      created_at: time(events[0] as GenesisEvent, "created_at"),
      updated_at: time(e, "updated_at"),
    };
  }),
};

const reviews: InverseSpec = {
  types: ["review.done"],
  rows: perGid((events, keys) => {
    const e = first("reviews", events, "review.done");
    const f = fields(e, keys);
    return {
      module: f.text("module"),
      done_at: time(e, "done_at", e.data.doneAt),
      notes: f.text("notes"),
      stats: f.json("stats"),
    };
  }),
};

/** Inverse builders of the core, budget, loans, assets and agent tables. */
export const CORE_INVERSE: Readonly<Record<string, InverseSpec>> = {
  profiles,
  profile_modules: profileModules,
  balances,
  import_batches: importBatches,
  loans,
  depreciations,
  asset_details: assetDetails,
  reviews,
};

/** Groups a vault's events of `spec.types` by gid (first-event order) and builds the rows. */
export function inverseRows(
  spec: InverseSpec,
  events: readonly GenesisEvent[],
  keys: GidKeys,
): GidRow[] {
  const types = new Set(spec.types);
  const groups = new Map<string, GenesisEvent[]>();
  for (const e of events) {
    if (!types.has(e.type)) continue;
    const group = groups.get(e.gid);
    if (group === undefined) groups.set(e.gid, [e]);
    else group.push(e);
  }
  return spec.rows([...groups.values()], keys);
}
