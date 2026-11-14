// The payment sheet's hook: one transaction live from the vault, its category written on tap (no Save,
// no undo: a wrong tap is corrected by tapping again; a tap while a write runs is kept and written
// after it, so the last tap wins), the owner's pin of its payee to the confirmed category, its details
// and the payee's earlier payments. Navigation stays in the route.
import { budget, type core, D, type IsoDate, Money } from "@cashu/domain";
import { formatCalendarDate } from "@cashu/i18n/values";
import { setMerchantCategory, setTransactionCategory } from "@cashu/store/budget/commands";
import { type CommandOutcome, useCommand, useQuery } from "@cashu/store-react";
import { type CategoryOption, useUiEnv } from "@cashu/ui/native";
import { useRef, useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import { categoryOptionsOf } from "../categories";
import { S as Rule } from "../categories.strings";
import { PREVIOUS_ATTEMPT_COMPLETED } from "../commandOutcomes";
import { localToday } from "../screenContext";
import { S } from "./Payment.strings";

/** Options shown before the grid is expanded. */
const COLLAPSED_CATEGORIES = 5;

export type PaymentSheetState =
  | { kind: "missing"; onClose(): void }
  | {
      kind: "ready";
      payee: string;
      amount: Money;
      dateLabel: string;
      account: string;
      statement: string | null;
      /** An own transfer; `counterpart` names the other account when the pair is known. */
      transfer: { counterpart: string | null } | null;
      /** An inflow: no category section. */
      income: boolean;
      category: {
        options: CategoryOption[];
        selected: string | null;
        /** The engine's suggestion (an LLM answer), ringed until the owner confirms or replaces it. */
        suggested: string | null;
        suggestedLabel: string | null;
        expanded: boolean;
        /** Options shown while collapsed. */
        collapsedCount: number;
        onPick(key: string): void;
        onExpand(): void;
        isSaving: boolean;
      } | null;
      rule: {
        on: boolean;
        title: string;
        /** "Also past and future ones (n so far)", or the pinned category once the payee is pinned. */
        sub: string;
        /** The owner already pinned the payee: the category it pins (the row shows always on). */
        fixed: string | null;
        /** Rows of the payee so far, this one included. */
        count: number;
        /** A rule needs a confirmed category: false while the payment has none (a suggestion is not one). */
        enabled: boolean;
        onToggle(on: boolean): void;
        isSaving: boolean;
      } | null;
      /** A write was refused or its outcome is unknown. */
      error: string | null;
      earlier: { rows: { gid: string; dateLabel: string; amount: Money }[] } | { first: true };
      /** "Imported {date} · open banking" when the import batch is known. */
      batch: string | null;
      onClose(): void;
    };

const SOURCES: Readonly<Record<string, () => string>> = {
  open_banking: () => S.sourceOpenBanking,
  csv: () => S.sourceCsv,
  manual: () => S.sourceManual,
  connector: () => S.sourceConnector,
};

/** What the sheet says after a write: nothing once it completed. */
function noticeOf(outcome: CommandOutcome<unknown>): string | null {
  if (outcome.kind === "completed") return null;
  // The earlier pick whose outcome was unknown is saved (the grid shows it live); the newer one was not
  // written, so the owner checks before picking again.
  if (outcome.kind === "not_started" && outcome.reason === PREVIOUS_ATTEMPT_COMPLETED)
    return S.firstSaveWent;
  return S.couldNotSave;
}

export function usePaymentSheet(args: {
  /** The vault the sheet was opened with (`usePinnedVault`): every write goes there, never to a later profile. */
  readonly vault: string;
  gid: string;
  lang: core.UiLang;
  today: IsoDate;
  close(): void;
}): PaymentSheetState {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const today = args.today;
  const detail = useQuery(moneyQueries.activity.detail, { txn: args.gid, lang: args.lang });
  const options = useQuery(moneyQueries.activity.categories, { lang: args.lang, today });
  const setCategory = useCommand(setTransactionCategory, { vault: args.vault });
  const pinMerchant = useCommand(setMerchantCategory, { vault: args.vault });
  const [expandedByOwner, setExpanded] = useState(false);
  // The last write's message: it failed, or an earlier save went through and the newer pick was not
  // written (`PREVIOUS_ATTEMPT_COMPLETED`); null when the last write completed.
  const [notice, setNotice] = useState<string | null>(null);
  // The owner's latest pick and whether a category write runs; read only in callbacks.
  const wanted = useRef<string | null>(null);
  const writing = useRef(false);
  if (detail === null) return { kind: "missing", onClose: args.close };

  const { row } = detail;
  const date = (value: IsoDate) => formatCalendarDate(value, locale, "medium");
  const labelOf = (key: string) =>
    options.find((o) => o.key === key)?.label ?? budget.categoryLabel(key, args.lang);
  const income = row.amount.gt(D("0")) && !row.internal;
  const categorizable = !income && !row.internal;
  const suggested = row.suggested ? row.category : null;
  const selected = row.suggested ? null : row.category;
  const grid = categoryOptionsOf(options);
  // A chosen or suggested category beyond the first cells opens the whole grid, so it shows.
  const hiddenPick =
    grid.findIndex((o) => o.key === (selected ?? suggested)) >= COLLAPSED_CATEGORIES;
  // One category write at a time: a pick while one runs is remembered and written when it completes,
  // so a quick second tap is never lost and the last tap wins.
  const write = (txn: string, key: string) => {
    writing.current = true;
    void setCategory.run({ txn, category: key }).then((outcome) => {
      const next = wanted.current;
      // A newer pick supersedes this one, whatever its outcome.
      if (next !== null && next !== key) return write(txn, next);
      writing.current = false;
      wanted.current = null;
      setNotice(noticeOf(outcome));
    });
  };
  const pick = (txn: string, key: string) => {
    wanted.current = key;
    setNotice(null);
    if (!writing.current) write(txn, key);
  };
  const pin = detail.merchantRule?.locked ? detail.merchantRule : null;
  const merchantKey = row.merchantKey;

  return {
    kind: "ready",
    payee: row.payee,
    amount: new Money(row.amount, row.currency),
    dateLabel: date(row.date),
    account: row.account.name,
    statement: row.title,
    transfer: row.internal
      ? { counterpart: detail.transferCounterpart?.account.name ?? null }
      : null,
    income,
    category: categorizable
      ? {
          options: grid,
          selected,
          suggested,
          suggestedLabel: suggested === null ? null : labelOf(suggested),
          expanded: expandedByOwner || hiddenPick,
          collapsedCount: COLLAPSED_CATEGORIES,
          onPick: (key) => pick(row.gid, key),
          onExpand: () => setExpanded(true),
          isSaving: setCategory.isPending,
        }
      : null,
    rule:
      categorizable && merchantKey !== null
        ? {
            on: pin !== null,
            title: Rule.ruleTitle(row.payee),
            sub:
              pin === null
                ? Rule.rulePast(detail.sameMerchantCount)
                : S.ruleActive(labelOf(pin.category)),
            fixed: pin === null ? null : labelOf(pin.category),
            count: detail.sameMerchantCount,
            enabled: selected !== null,
            onToggle: (on) => {
              // One-way on the phone: no command removes a pin, so only switching it on writes. It
              // pins the confirmed category only, never the engine's suggestion.
              if (!on || pin !== null || selected === null) return;
              setNotice(null);
              void pinMerchant
                .run({ merchantKey, category: selected })
                .then((outcome) => setNotice(noticeOf(outcome)));
            },
            isSaving: pinMerchant.isPending,
          }
        : null,
    error: notice,
    earlier:
      detail.earlier.length === 0
        ? { first: true }
        : {
            rows: detail.earlier.map((r) => ({
              gid: r.gid,
              dateLabel: date(r.date),
              amount: new Money(r.amount, r.currency),
            })),
          },
    batch:
      detail.batch?.finishedAt == null
        ? null
        : S.imported(
            date(localToday(new Date(detail.batch.finishedAt))),
            SOURCES[detail.batch.source]?.() ?? detail.batch.source,
          ),
    onClose: args.close,
  };
}
