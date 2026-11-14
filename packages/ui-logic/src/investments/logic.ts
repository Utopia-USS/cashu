// Workspace logic without React: decision tags and the decision effect line, the next deposit,
// data warnings, manual transaction rules and rule run errors. Unit-tested in src/testing.
import {
  type AccountLike,
  accountLabel,
  bucketLabel,
  DECISION_ACTION,
  dm,
  pct,
  pctTarget,
  plainMoney,
  pp,
  qty,
} from "./labels.js";
import { S } from "./logic.strings.js";

export interface BucketLike {
  bucket_id: string;
  weight: number | null;
  target: number;
  drift_pp: number;
  value: number;
  to_target: number;
  out_of_band: boolean | null;
}

/** Latest decision's short label: "decyzja: dokupuję 20 szt." */
export function decisionTag(
  d: { action: string; quantity: number | null } | undefined,
): string | null {
  if (!d) return null;
  const q =
    d.quantity != null && (d.action === "bought" || d.action === "sold")
      ? S.pieces(qty(d.quantity))
      : "";
  return S.decisionTag(DECISION_ACTION[d.action] ?? d.action, q);
}

/** Next planned deposit date (contribution_gap "Odłóż do"): the plan's day in this or next month. */
export function nextDeposit(today: string, day: number | null): string {
  const [y = Number.NaN, m = Number.NaN, d = Number.NaN] = today.split("-").map(Number);
  const want = day ?? 10;
  const last = (yy: number, mm: number) => new Date(yy, mm, 0).getDate();
  let yy = y,
    mm = m;
  if (d >= want) {
    mm += 1;
    if (mm > 12) {
      mm = 1;
      yy += 1;
    }
  }
  const dd = Math.min(want, last(yy, mm));
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// ---- allocation ------------------------------------------------------------------

/** Effect of a planned trade on its bucket (buying with the account's cash keeps the total). */
export function decisionEffect(args: {
  side: "buy" | "sell";
  quantity: number | null;
  price: number | null;
  currency: string;
  bucket: BucketLike | null;
  total: number;
  base: string;
}): string | null {
  const { side, quantity, price, bucket, total } = args;
  if (quantity == null || price == null || quantity <= 0 || price <= 0) return null;
  const amount = quantity * price;
  // quantity x price is on the screen: in bananas it would give the scale away.
  const head = `≈ ${plainMoney(amount, args.currency)}`;
  // A non-generic (the owner's own) bucket is not named in the app, nor are its target and drift (F7-generic).
  if (!bucket || !total || args.currency !== args.base || !bucketLabel(bucket.bucket_id))
    return head;
  const after = (bucket.value + (side === "buy" ? amount : -amount)) / total;
  const drift = (after - bucket.target) * 100;
  const grows = Math.abs(drift) > Math.abs(bucket.drift_pp) + 1e-9;
  return S.effect(
    head,
    bucketLabel(bucket.bucket_id) ?? "",
    pct(after),
    pctTarget(bucket.target),
    grows,
    pp(drift),
  );
}

// ---- weekly review ---------------------------------------------------------------

// ---- warnings --------------------------------------------------------------------
export interface WarningItem {
  key: string;
  tone: "review" | "resolved";
  title: string;
  hint: string;
  action?: "snapshot" | "alias" | "classify" | "import";
}

/** Data warnings for the rail: portfolio warnings (titles by kind) plus account snapshot age.
 * `labels`: instrument id -> label; `accounts` for names; `today` for the snapshot age. */
export function warningItems(args: {
  warnings: {
    kind: string;
    message: string;
    account_id: number | null;
    instrument_id: number | null;
  }[];
  labels: Map<string, string>;
  accounts: (AccountLike & {
    snapshot_date?: string | null;
    last_import?: { at: string } | null;
  })[];
  stale: { instrument_id: number; label: string; price_date: string | null }[];
  missingFx: string[];
  today: string;
}): WarningItem[] {
  const out: WarningItem[] = [];
  const seen = new Set<string>();
  const add = (w: WarningItem) => {
    if (!seen.has(w.key)) {
      seen.add(w.key);
      out.push(w);
    }
  };
  const accName = (id: number | null) => {
    const a = args.accounts.find((x) => x.id === id);
    return a ? accountLabel(a, args.accounts) : S.account;
  };
  const inst = (id: number | null) =>
    id != null ? (args.labels.get(String(id)) ?? S.instrumentN(id)) : S.instrument;
  for (const a of args.accounts) {
    if (!a.last_import) continue; // nothing imported yet: nothing to reconcile
    const age = a.snapshot_date ? daysBetween(a.snapshot_date, args.today) : null;
    if (age == null)
      add({
        key: `snap:${a.id}`,
        tone: "review",
        title: S.noSnapshot(accountLabel(a, args.accounts)),
        hint: S.noReconcile,
        action: "snapshot",
      });
    else if (age > 14)
      add({
        key: `snap:${a.id}`,
        tone: "review",
        title: S.snapshotOld(accountLabel(a, args.accounts), dm(a.snapshot_date)),
        hint: S.noReconcile,
        action: "snapshot",
      });
  }
  for (const st of args.stale) {
    add({
      key: `stale:${st.instrument_id}`,
      tone: "review",
      title: S.withTitle(st.label, S.stalePrice),
      hint: st.price_date ? S.lastQuote(dm(st.price_date)) : S.noQuotes,
      action: "alias",
    });
  }
  for (const c of args.missingFx) {
    add({ key: `fx:${c}`, tone: "resolved", title: S.fxUnavailable(c), hint: S.fxSkipped });
  }
  const unknownCost = new Map<string, number>();
  for (const w of args.warnings) {
    const fx = /([A-Z]{3})\/[A-Z]{3}/.exec(w.message)?.[1];
    switch (w.kind) {
      case "stale_price":
      case "last_known_price_used":
        add({
          key: `stale:${w.instrument_id}`,
          tone: "review",
          title: S.withTitle(
            inst(w.instrument_id),
            w.kind === "stale_price" ? S.stalePrice : S.lastTradePrice,
          ),
          hint: S.checkAlias,
          action: "alias",
        });
        break;
      case "missing_price":
        add({
          key: `price:${w.instrument_id}`,
          tone: "review",
          title: S.withTitle(inst(w.instrument_id), S.noPrice),
          hint: S.positionSkipped,
          action: "alias",
        });
        break;
      case "missing_fx_rate":
      case "stale_fx_rate":
        add({
          key: `fx:${fx ?? w.message}`,
          tone: "resolved",
          title: S.fxRate(fx ?? "", w.kind === "stale_fx_rate").replace("  ", " "),
          hint: S.refreshesNextRun,
        });
        break;
      case "unknown_cost_basis":
      case "missing_cost_basis": {
        const k = String(w.instrument_id ?? "?");
        unknownCost.set(k, (unknownCost.get(k) ?? 0) + 1);
        break;
      }
      case "history_gap":
        add({
          key: `gap:${w.account_id}:${w.instrument_id}`,
          tone: "review",
          title: S.historyGap(accName(w.account_id)),
          hint: S.historyGapHint(inst(w.instrument_id)),
          action: "import",
        });
        break;
      case "cash_history_gap":
        add({
          key: `cash:${w.account_id}`,
          tone: "review",
          title: S.negativeCash(accName(w.account_id)),
          hint: S.negativeCashHint,
          action: "import",
        });
        break;
      case "frozen_valued_at_zero":
      case "missing_manual_valuation":
        add({
          key: `manual:${w.instrument_id}`,
          tone: "review",
          title: S.withTitle(inst(w.instrument_id), S.noManualValuation),
          hint: S.valuedAtZero,
        });
        break;
      case "missing_instrument":
        add({
          key: `inst:${w.instrument_id}`,
          tone: "review",
          title: S.withTitle(inst(w.instrument_id), S.noInstrumentData),
          hint: S.substituteValuation,
        });
        break;
      default:
        add({
          key: `${w.kind}:${w.account_id}:${w.instrument_id}`,
          tone: "resolved",
          title: S.dataWarning,
          hint: w.message,
        });
    }
  }
  const lots = [...unknownCost.values()].reduce((a, b) => a + b, 0);
  if (lots)
    add({
      key: "cost",
      tone: "review",
      title: S.noCostBasis(lots),
      hint: S.noCostBasisHint,
      action: "import",
    });
  return out;
}

export function daysBetween(a: string, b: string): number {
  const [ay = Number.NaN, am = Number.NaN, ad = Number.NaN] = a.slice(0, 10).split("-").map(Number);
  const [by = Number.NaN, bm = Number.NaN, bd = Number.NaN] = b.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ---- manual transaction form ---------------------------------------------------------
export type Need = "required" | "optional" | "none";
export interface TxnRule {
  instrument: Need;
  quantity: Need;
  price: Need;
  amount: Need;
  split: boolean;
  sign: "out" | "in" | "neutral" | "any";
}

/** What the manual form asks for per type (docs/import-format.md section 4, mirrored by the
 * backend's validation). `amount` is the gross amount for cash events. */
export const TXN_RULES: Record<string, TxnRule> = {
  buy: {
    instrument: "required",
    quantity: "required",
    price: "required",
    amount: "none",
    split: false,
    sign: "out",
  },
  sell: {
    instrument: "required",
    quantity: "required",
    price: "required",
    amount: "none",
    split: false,
    sign: "in",
  },
  dividend: {
    instrument: "optional",
    quantity: "optional",
    price: "none",
    amount: "required",
    split: false,
    sign: "in",
  },
  interest: {
    instrument: "optional",
    quantity: "none",
    price: "none",
    amount: "required",
    split: false,
    sign: "in",
  },
  deposit: {
    instrument: "none",
    quantity: "none",
    price: "none",
    amount: "required",
    split: false,
    sign: "in",
  },
  withdrawal: {
    instrument: "none",
    quantity: "none",
    price: "none",
    amount: "required",
    split: false,
    sign: "out",
  },
  fee: {
    instrument: "optional",
    quantity: "none",
    price: "none",
    amount: "required",
    split: false,
    sign: "out",
  },
  tax: {
    instrument: "optional",
    quantity: "none",
    price: "none",
    amount: "required",
    split: false,
    sign: "out",
  },
  split: {
    instrument: "required",
    quantity: "none",
    price: "none",
    amount: "none",
    split: true,
    sign: "neutral",
  },
  transfer_in: {
    instrument: "required",
    quantity: "required",
    price: "optional",
    amount: "none",
    split: false,
    sign: "neutral",
  },
  transfer_out: {
    instrument: "required",
    quantity: "required",
    price: "none",
    amount: "none",
    split: false,
    sign: "neutral",
  },
  adjustment: {
    instrument: "required",
    quantity: "required",
    price: "optional",
    amount: "none",
    split: false,
    sign: "neutral",
  },
};

export interface TxnFormValues {
  type: string;
  hasInstrument: boolean;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fee: number | null;
  split: number | null;
  date: string;
}

/** Client-side check of the manual form; returns messages per field (empty = ok). */
export function validateTxn(v: TxnFormValues, today: string): Record<string, string> {
  const r = TXN_RULES[v.type];
  const e: Record<string, string> = {};
  if (!r) return { type: S.errType };
  if (!v.date) e.date = S.errDate;
  else if (v.date > today) e.date = S.errFutureDate;
  if (r.instrument === "required" && !v.hasInstrument) e.instrument = S.errInstrument;
  if (r.quantity === "required" && !(v.quantity != null && v.quantity > 0))
    e.quantity = S.errQtyPositive;
  if (r.quantity === "optional" && v.quantity != null && v.quantity < 0)
    e.quantity = S.errQtyNegative;
  if (r.price === "required" && !(v.price != null && v.price > 0)) e.price = S.errPrice;
  if (r.price === "optional" && v.price != null && v.price < 0) e.price = S.errPriceNegative;
  if (r.amount === "required" && !(v.amount != null && v.amount > 0)) e.amount = S.errAmount;
  if (v.fee != null && v.fee < 0) e.fee = S.errFee;
  if (r.split && !(v.split != null && v.split > 0)) e.split = S.errSplit;
  return e;
}

/** Cash effect of the manual form (signed, trade currency) for the summary line. */
export function txnCash(
  v: Pick<TxnFormValues, "type" | "quantity" | "price" | "amount" | "fee">,
): number | null {
  const r = TXN_RULES[v.type];
  if (!r || r.sign === "neutral") return r ? 0 : null;
  const gross =
    r.amount !== "none"
      ? v.amount
      : v.quantity != null && v.price != null
        ? v.quantity * v.price
        : null;
  if (gross == null) return null;
  const fee = v.fee ?? 0;
  return r.sign === "out" ? -(gross + fee) : gross - fee;
}

/** A rule run error (backend, English) -> short text for the Reguły KPI. */
export function runError(msg: string | null | undefined): string {
  if (!msg) return "";
  // Never the strategy's rule id (FE-A A6 sweep).
  if (/^rule (\S+) inactive/i.test(msg)) return S.ruleInactive;
  if (/stooq|yahoo|nbp|price source|timed? ?out|connect|network|http/i.test(msg))
    return S.priceSourceDown;
  if (/strategy/i.test(msg)) return S.strategyProblem;
  return msg.length > 80 ? `${msg.slice(0, 77)}…` : msg;
}
