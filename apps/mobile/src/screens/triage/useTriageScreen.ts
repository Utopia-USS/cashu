// The categorize deck (full-screen modal): the uncategorized payments one card at a time, newest
// first, of one month and currency when opened from Today (what its line counts), else of the whole
// vault. The order is taken once from the first result, so a card that leaves the live query (filed
// here, by a merchant rule, or on another device) never reshuffles the rest; Skip moves the card to the
// end. A pick files the payment (and, with the toggle on, pins the merchant first), then the next card.
// The deck holds one page of the query; when it runs out while more wait, the done state continues.
import { type core, type IsoDate, Money } from "@cashu/domain";
import { setMerchantCategory, setTransactionCategory } from "@cashu/store/budget/commands";
import { budgetUncategorizedRows } from "@cashu/store/budget/companion";
import { useCommand, useQuery } from "@cashu/store-react";
import { type CategoryOption, type SwatchColor, useUiEnv } from "@cashu/ui/native";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import { categoryOptionsOf, categorySwatch } from "../categories";
import { S as Rule } from "../categories.strings";
import { S } from "./Triage.strings";

/** The deck's size: the newest uncategorized payments, as the store pages them. */
const DECK_LIMIT = 50;
/** Up to this many payments the progress shows as dots; above it the card's "n of m" alone. */
const MAX_DOTS = 20;

/** The deck's scope: one month ("YYYY-MM") of one currency; null for the whole vault. */
export type TriageScope = { readonly month: string; readonly currency: string } | null;

interface TriageCard {
  readonly gid: string;
  readonly payee: string;
  readonly amount: Money;
  readonly dateLabel: string;
  readonly account: string;
  /** The statement text; null when it says no more than the payee. */
  readonly statement: string | null;
  /** The merchant's earlier decision in this vault; null without one (the grid shows directly). */
  readonly suggestion: {
    readonly key: string;
    readonly label: string;
    readonly swatch: SwatchColor;
  } | null;
}

export type TriageState =
  | { readonly kind: "empty"; onClose(): void }
  | {
      readonly kind: "done";
      /** Payments filed in this deck. */
      readonly count: number;
      /** Payments of the scope still without a category beyond the deck's page; 0 when none. */
      readonly left: number;
      /** Deal the next page; null when nothing is left. */
      readonly onContinue: (() => void) | null;
      onClose(): void;
    }
  | {
      readonly kind: "card";
      /** Cards filed so far (the shown card is number `done + 1`). */
      readonly done: number;
      /** Filed so far plus the scope's payments still without a category. */
      readonly total: number;
      /** The progress shows as dots (a short deck). */
      readonly dots: boolean;
      readonly card: TriageCard;
      /** The card behind the top one. */
      readonly next: { readonly payee: string; readonly amount: Money } | null;
      readonly grid: {
        readonly options: readonly CategoryOption[];
        readonly selected: null;
        readonly suggested: string | null;
        readonly expanded: boolean;
        onPick(key: string): void;
        onExpand(): void;
      };
      /** "Same for every {payee} payment"; null when the payment has no merchant to pin. */
      readonly rule: {
        readonly on: boolean;
        onToggle(on: boolean): void;
        readonly label: string;
        readonly sub: string;
      } | null;
      readonly isSaving: boolean;
      /** The last write of this card was not saved. */
      readonly error: string | null;
      onUseSuggestion(): void;
      onSkip(): void;
      onClose(): void;
    };

const dayLabels = new Map<string, Intl.DateTimeFormat>();
function dayLabel(date: string, locale: string): string {
  let format = dayLabels.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    dayLabels.set(locale, format);
  }
  return format.format(new Date(`${date}T12:00:00Z`));
}

export function useTriageScreen(args: {
  /** The vault the modal was opened with (`usePinnedVault`): every write goes there, never to a later profile. */
  readonly vault: string;
  readonly lang: core.UiLang;
  readonly today: IsoDate;
  readonly scope: TriageScope;
  close(): void;
}): TriageState {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const live = useQuery(budgetUncategorizedRows, {
    limit: DECK_LIMIT,
    ...(args.scope === null ? {} : { month: args.scope.month, currency: args.scope.currency }),
  });
  const categories = useQuery(moneyQueries.activity.categories, {
    today: args.today,
    lang: args.lang,
  });
  const [order, setOrder] = useState<readonly string[]>(() => live.rows.map((r) => r.gid));
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  /** Cards that left earlier pages of the deck. */
  const [carried, setCarried] = useState(0);
  const [ruleOn, setRuleOn] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const fileTxn = useCommand(setTransactionCategory, { vault: args.vault });
  const pinMerchant = useCommand(setMerchantCategory, { vault: args.vault });

  const byGid = new Map(live.rows.map((r) => [r.gid, r]));
  const open = order.flatMap((gid) => {
    const row = handled.has(gid) ? undefined : byGid.get(gid);
    return row === undefined ? [] : [row];
  });
  const row = open[0];
  const detail = useQuery(moneyQueries.activity.detail, { txn: row?.gid ?? "", lang: args.lang });

  // A card is done once it left the deck: filed here, or by a merchant rule, or elsewhere.
  const done = carried + order.length - open.length;
  if (order.length === 0) return { kind: "empty", onClose: args.close };
  if (row === undefined) {
    // Every card of the page is filed; the query's next page holds what is left (if anything).
    const more = live.rows.filter((r) => !handled.has(r.gid)).map((r) => r.gid);
    return {
      kind: "done",
      count: done,
      left: live.total,
      onContinue:
        more.length === 0
          ? null
          : () => {
              setCarried(done);
              setOrder(more);
            },
      onClose: args.close,
    };
  }

  const options = categoryOptionsOf(categories);
  const suggested =
    row.suggestion === null ? undefined : categories.find((c) => c.key === row.suggestion);
  const merchantKey = row.merchantKey;
  // A card that leaves the live total joins `done`, so the sum holds while the deck runs.
  const total = done + live.total;

  const pick = async (category: string) => {
    setFailed(null);
    // The merchant first: if it is refused nothing changed, and the card stays for another try.
    if (ruleOn && merchantKey !== null) {
      const pinned = await pinMerchant.run({ merchantKey, category });
      if (pinned.kind !== "completed") return setFailed(row.gid);
    }
    const filed = await fileTxn.run({ txn: row.gid, category });
    if (filed.kind !== "completed") return setFailed(row.gid);
    setHandled((prev) => new Set(prev).add(row.gid));
    setRuleOn(false);
    setExpanded(false);
  };

  const behind = open[1];
  return {
    kind: "card",
    done,
    total,
    dots: total <= MAX_DOTS,
    card: {
      gid: row.gid,
      payee: row.payee,
      amount: new Money(row.amount, row.currency),
      dateLabel: dayLabel(row.date, locale),
      account: row.account.name,
      statement: row.title,
      suggestion:
        suggested === undefined
          ? null
          : { key: suggested.key, label: suggested.label, swatch: categorySwatch(suggested.key) },
    },
    next:
      behind === undefined
        ? null
        : { payee: behind.payee, amount: new Money(behind.amount, behind.currency) },
    grid: {
      options,
      selected: null,
      suggested: suggested?.key ?? null,
      expanded,
      onPick: (key) => void pick(key),
      onExpand: () => setExpanded(true),
    },
    rule:
      merchantKey === null
        ? null
        : {
            on: ruleOn,
            onToggle: setRuleOn,
            label: Rule.ruleTitle(row.payee),
            sub: Rule.rulePast(detail?.sameMerchantCount ?? 1),
          },
    isSaving: fileTxn.isPending || pinMerchant.isPending,
    error: failed === row.gid ? S.couldNotSave : null,
    onUseSuggestion: () => {
      if (suggested !== undefined) void pick(suggested.key);
    },
    onSkip: () => {
      setFailed(null);
      setRuleOn(false);
      setExpanded(false);
      setOrder((prev) => [...prev.filter((gid) => gid !== row.gid), row.gid]);
    },
    onClose: args.close,
  };
}
