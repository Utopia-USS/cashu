// The Net worth tab: one currency's own net worth or every currency converted at the NBP rate the
// device holds (labelled with the table's own date, the other currencies beside it), the 12-month
// history, the facts, and the accounts, loans and valued assets of the current vault.
import { addDays, addMonths, core, D, type Decimal, type IsoDate, Money } from "@cashu/domain";
import { depreciatedValue } from "@cashu/domain/assets";
import { formatDecimalValue } from "@cashu/i18n/values";
import { enabledModules } from "@cashu/store/core/profile";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import { useTabChrome } from "../../shell/useTabChrome";
import type {
  NetWorthAccountRow,
  NetWorthAssetRow,
  NetWorthHero,
  NetWorthLoanRow,
  NetWorthViewProps,
} from "../money-contracts";
import { plotRatios } from "../screenContext";
import { S } from "./NetWorth.strings";

const INSTITUTIONS = core.builtinRegistry().institutions;
/** A valuation older than this reads as not updated for a while. */
const STALE_DAYS = 365;

const monthFormats = new Map<string, Intl.DateTimeFormat>();
const rateDayFormats = new Map<string, Intl.DateTimeFormat>();

function cached(
  map: Map<string, Intl.DateTimeFormat>,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let format = map.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    map.set(locale, format);
  }
  return format;
}

const noon = (date: IsoDate) => new Date(`${date}T12:00:00Z`);

/** The month of a date as it follows "since": English "October", Polish genitive "października". */
function sinceMonth(date: IsoDate, locale: string): string {
  const parts = cached(monthFormats, locale, { day: "numeric", month: "long" }).formatToParts(
    noon(date),
  );
  return parts.find((p) => p.type === "month")?.value ?? date.slice(0, 7);
}

/** The NBP table day: "Tue, Nov 10" / "wt., 10 lis". */
function rateDay(date: IsoDate, locale: string): string {
  return cached(rateDayFormats, locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(noon(date));
}

function assetKind(type: string, kind: "manual" | "vehicle"): NetWorthAssetRow["kind"] {
  if (kind === "vehicle" || type === "vehicle") return "vehicle";
  return type === "property" ? "property" : "other";
}

export function useNetWorthScreen(args: {
  readonly today: IsoDate;
  readonly openLoan: (gid: string) => void;
  readonly openProfile: () => void;
}): NetWorthViewProps {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const header = useTabChrome({ fresh: "bank", openProfile: args.openProfile });
  const today = args.today;
  const lang = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const summary = useQuery(moneyQueries.overview.summary, { today });
  const heroView = useQuery(moneyQueries.overview.hero, { today });
  const modules = useQuery(enabledModules);
  const accountLines = useQuery(moneyQueries.holdings.accounts, { today });
  const assetLines = useQuery(moneyQueries.holdings.assets, { today });
  const loanLines = useQuery(moneyQueries.loans.screen, { today });
  const [requested, setRequested] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);

  const headline = heroView.facts.currency;
  const currencies = Object.keys(summary.networth);
  const currency =
    requested !== null && currencies.includes(requested)
      ? requested
      : currencies.includes(headline)
        ? headline
        : (currencies[0] ?? headline);
  const converted = currency === headline ? heroView.converted : null;
  const isConverted = converted !== null && converted.rateDate !== null;

  const history = useQuery(moneyQueries.overview.netWorthSeries, {
    today,
    currency,
    lang,
    convert: isConverted,
  });
  const from = addMonths(today, -12);
  const points = history.points.filter((p) => p.date >= from);
  const display = (value: Decimal) => formatDecimalValue(value, locale, { currency }).text;
  const first = points[0];
  const last = points.at(-1);
  const xIndices = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (i, pos, all) => i >= 0 && all.indexOf(i) === pos,
  );

  const own = summary.networth[currency];
  const hero: NetWorthHero = {
    label: isConverted ? "converted" : "net",
    value: isConverted
      ? new Money(converted.net, currency)
      : own === undefined
        ? null
        : new Money(own, currency),
    change:
      currency === headline && heroView.change !== null
        ? {
            amount: new Money(heroView.change.change, currency),
            pct: heroView.change.changePct,
            sinceLabel: S.since(sinceMonth(heroView.change.since, locale)),
          }
        : null,
    parts: isConverted
      ? converted.parts.flatMap((p) =>
          p.quote === null
            ? []
            : [{ currency: p.currency, amount: new Money(p.amount, p.currency) }],
        )
      : [],
    rateDate:
      isConverted && converted.rateDate !== null ? rateDay(converted.rateDate, locale) : null,
    otherCurrencies:
      converted !== null && !isConverted
        ? converted.parts.map((p) => ({
            currency: p.currency,
            amount: new Money(p.amount, p.currency),
          }))
        : [],
    missingRate: converted?.parts.filter((p) => p.quote === null).map((p) => p.currency) ?? [],
  };

  // Facts: the converted figures when converting, else the headline currency's own.
  const facts = heroView.facts;
  const sums =
    isConverted && converted !== null
      ? converted
      : { assets: facts.assets, liabilities: facts.liabilities, liquid: facts.liquid };
  const months = core.monthsOfSpending(sums.liquid, heroView.norm?.expense ?? null);
  const showFacts = currency === headline;
  const factRows: NetWorthViewProps["facts"] = showFacts
    ? [
        { label: S.owned, value: new Money(sums.assets, headline) },
        {
          label: S.owed,
          value: new Money(sums.liabilities.neg(), headline),
          ...(sums.liabilities.isZero() ? { detail: S.noLoans } : {}),
        },
        ...(facts.homeEquity === null
          ? []
          : [{ label: S.homeEquity, value: new Money(facts.homeEquity, headline) }]),
        {
          label: S.cashAtHand,
          value: new Money(sums.liquid, headline),
          ...(months === null
            ? {}
            : {
                detail: S.monthsOfSpending(
                  formatDecimalValue(months, locale, { fractionDigits: 1 }).text,
                ),
              }),
        },
      ]
    : [];

  // Accounts: the money lines (no loans, no valued assets).
  const assetIds = new Set(assetLines.map((a) => a.gid));
  const allAccounts: NetWorthAccountRow[] = accountLines
    .filter((line) => !line.liability && !assetIds.has(line.gid))
    .map((line) => ({
      gid: line.gid,
      name: line.name,
      bank:
        line.type === "cash" || line.bank === "manual" || line.bank === ""
          ? null
          : INSTITUTIONS.displayName(line.bank, lang),
      amount: line.amount === null ? null : new Money(line.amount, line.currency),
      asOf: line.asOf,
      type: line.type,
    }));
  const isEmpty = (row: NetWorthAccountRow) => row.amount === null || row.amount.amount.isZero();
  const emptyCount = allAccounts.filter(isEmpty).length;
  const accounts = showEmpty ? allAccounts : allAccounts.filter((row) => !isEmpty(row));

  const loans: NetWorthLoanRow[] = loanLines
    .filter((loan) => loan.outstanding.gt(D("0")))
    .map((loan) => ({
      gid: loan.id,
      name: loan.name || S.loan,
      outstanding: new Money(loan.outstanding.neg(), loan.currency),
      monthly: new Money(loan.monthlyPayment, loan.currency),
      payoffDate: loan.payoffDate,
      // The repaid share fills the meter (as on the loan page).
      share: loan.principal.isZero()
        ? 0
        : Math.max(0, 1 - Math.min(1, Number(loan.outstanding.div(loan.principal).toString()))),
    }));

  const staleBefore = addDays(today, -STALE_DAYS);
  const assets: NetWorthAssetRow[] = assetLines.flatMap((line) => {
    if (line.amount === null || line.asOf === null) return [];
    const dep = line.depreciation;
    const nextMonth = addMonths(today, 1);
    const loss =
      dep === null
        ? null
        : depreciatedValue(
            dep.purchasePrice,
            dep.purchaseDate,
            dep.annualRate,
            today,
            dep.floor,
          ).sub(
            depreciatedValue(
              dep.purchasePrice,
              dep.purchaseDate,
              dep.annualRate,
              nextMonth,
              dep.floor,
            ),
          );
    return [
      {
        gid: line.gid,
        name: line.name,
        kind: assetKind(line.type, line.kind),
        amount: new Money(line.amount, line.currency),
        asOf: line.asOf,
        stale: dep === null && line.asOf < staleBefore,
        depreciationPerMonth:
          loss === null || !loss.gt(D("0")) ? null : new Money(loss, line.currency),
      },
    ];
  });

  return {
    header,
    currency,
    currencies,
    onCurrencyPicked: setRequested,
    hero,
    chart: {
      label: S.history,
      valueKind: "amount",
      yFormat: false,
      height: 80,
      series: [
        {
          name: S.value,
          area: true,
          values: plotRatios(points.map((p) => p.value)),
          accessibleSummary:
            first && last
              ? `${S.from} ${first.date} ${display(first.value)} ${S.to} ${last.date} ${display(last.value)}`
              : S.noHistory,
        },
      ],
      xLabels: xIndices.map((i) => ({ i, text: points[i]?.date.slice(0, 7) ?? "" })),
      tooltip: (i) => {
        const point = points[i];
        return {
          title: point?.date ?? "",
          rows: point ? [{ name: S.value, value: display(point.value), amount: true }] : [],
        };
      },
    },
    facts: factRows,
    accounts,
    emptyCount,
    showEmpty,
    loans,
    assets,
    partnerFirst: !modules.includes("investments"),
    onLoanPressed: args.openLoan,
    onShowEmptyToggled: () => setShowEmpty((on) => !on),
  };
}
