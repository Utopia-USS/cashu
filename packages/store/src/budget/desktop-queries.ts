// S55c desktop adapters preserve the budget API's projections over one live native vault.
import { budget, core, D, type Decimal, type IsoDate } from "@cashu/domain";
import { enabledModuleIds } from "../core/queries.js";

import { defineQuery, type Read } from "../query.js";
import { budgetCliCushionEnv, budgetCliSettings } from "./cli-queries.js";
import { budgetBook, budgetEngineContext } from "./read-models.js";

export interface UncategorizedMerchant {
  readonly merchantKey: string;
  readonly sample: string;
  readonly count: number;
  readonly total: Decimal;
  readonly currency: string;
}

export interface BudgetDesktopSources {
  readonly registry?: core.CoreRegistry;
  readonly paymentPatterns?: (read: Read) => readonly core.PaymentPattern[];
  readonly plannedContribution?: (read: Read) => budget.PlannedContribution | null;
}

/** Providers are supplied by the host; renderer query descriptors only contribute stable ids. */
export function budgetDesktopQueries(sources: BudgetDesktopSources = {}) {
  return {
    drill: defineQuery({
      id: "budget.desktopDrill",
      run(
        read,
        args: {
          currency: string;
          category: string;
          period: { year?: number | null; month?: number | null; quarter?: number | null };
          sort: "date" | "amount";
          order: "asc" | "desc";
        },
      ) {
        return budget.categoryTransactions(budgetBook(read), args.category, args.currency, {
          ...args.period,
          sort: args.sort,
          order: args.order,
        });
      },
    }),
    uncategorized: defineQuery({
      id: "budget.desktopUncategorized",
      run(read, args: { currency: string }): UncategorizedMerchant[] {
        const book = budgetBook(read);
        const currency = args.currency || book.baseCurrency;
        const groups = new Map<string, UncategorizedMerchant>();
        for (const row of book.transactions) {
          if (
            row.currency !== currency ||
            row.amount.gte(D("0")) ||
            row.isInternalTransfer ||
            row.categorySource !== "default"
          )
            continue;
          const merchantKey = budget.merchantKey(
            row.counterpartyName,
            row.reference,
            row.description,
          );
          if (!merchantKey) continue;
          const previous = groups.get(merchantKey);
          groups.set(merchantKey, {
            merchantKey,
            sample: previous?.sample ?? (row.reference || row.description || merchantKey),
            count: (previous?.count ?? 0) + 1,
            total: (previous?.total ?? D("0")).sub(row.amount),
            currency,
          });
        }
        return [...groups.values()].sort((a, b) => b.total.compare(a.total)).slice(0, 30);
      },
    }),
    subscriptions: defineQuery({
      id: "budget.desktopSubscriptions",
      run(read) {
        const book = budgetBook(read);
        const registry = sources.registry ?? core.builtinRegistry();
        const candidates = budget.recurringPayments(
          book,
          budgetEngineContext(read, sources.paymentPatterns?.(read) ?? [], registry),
          budget.subscriptionExclusions(registry),
        );
        const active = budget.activeRecurring(candidates, book);
        return candidates.map((row) => ({ ...row, active: active.includes(row) }));
      },
    }),
    settings: defineQuery({
      id: "budget.desktopSettings",
      run(read) {
        const book = budgetBook(read);
        const types = (sources.registry ?? core.builtinRegistry()).accountTypes;
        return {
          settings: budgetCliSettings(read),
          accounts: book.accounts
            .filter(
              (a) =>
                a.removedAt === null &&
                ["checking", "savings", "cash"].includes(a.type) &&
                types.get(a.type)?.sign !== "liability",
            )
            .map((a) => ({ gid: a.id, name: a.name, currency: a.currency })),
        };
      },
    }),
    monthClose: defineQuery({
      id: "budget.desktopMonthClose",
      run(read, args: { today: IsoDate; month: string | null; lang: "pl" | "en" }) {
        const settings = budgetCliSettings(read);
        const parsed = args.month === null ? null : budget.parseMonth(args.month);
        if (parsed !== null && !parsed.ok) throw new RangeError("invalid budget month");
        const settingsUnavailable = settings === null;
        const investmentsEnabled = enabledModuleIds(read).has("investments");
        const strategyUnavailable = investmentsEnabled && sources.plannedContribution === undefined;
        const close = budget.monthClose(budgetBook(read), {
          today: args.today,
          settings: settings ?? budget.defaultBudgetSettings(),
          env: budgetCliCushionEnv(read),
          investmentsEnabled,
          planned: investmentsEnabled ? (sources.plannedContribution?.(read) ?? null) : null,
          ...(parsed?.ok ? { year: parsed.year, month: parsed.month } : {}),
        });
        const view = budget.monthCloseView(close, args.lang);
        return {
          close: {
            ...view,
            currencies: view.currencies.map((row) => ({
              ...row,
              cushionTopUp: settingsUnavailable ? null : row.cushionTopUp,
              suggestedTransfer: settingsUnavailable ? null : row.suggestedTransfer,
            })),
            investing:
              settingsUnavailable && view.investing
                ? { ...view.investing, comparison: null }
                : view.investing,
          },
          strategyUnavailable,
          settingsUnavailable,
        };
      },
    }),
  };
}
