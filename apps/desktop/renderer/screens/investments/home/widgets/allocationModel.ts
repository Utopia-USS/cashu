// AllocationWidget (ab24ab6 v2/Portfolio.tsx:267-355) with AccountsRows (:236-265), DataWarnings (:210-234) and the
// portfolio priority banner: four views `Koszyki | Klasy | Regiony | Rachunki`, the donut with its rows, drift
// coloured only out of band. Every text is formatted here; the View lays it out.
import { S } from "@cashu/i18n/investments/v2/Portfolio.strings";
import type { ChartColor, DonutProps } from "@cashu/ui";
import { hideAmount } from "@cashu/ui-logic/core/incognito";
import {
  accountLabel,
  assetClass,
  bucketColor,
  bucketGenitive,
  bucketLabel,
  dm,
  money0,
  nAccountsInv,
  nBuckets,
  pct,
  pctTarget,
  pp,
  region,
} from "@cashu/ui-logic/investments/labels";
import { warningItems } from "@cashu/ui-logic/investments/logic";
import type { Overview } from "@cashu/ui-logic/investments/types";
import { accountSnapshot, allocGeneric, ruleKindLabel } from "@cashu/ui-logic/investments/v2/logic";
import type { InvestmentsHomeData } from "../useInvestmentsHomeData.js";

export type AllocView = "buckets" | "classes" | "regions" | "accounts";

export interface AllocationUi {
  /** Null = the default (Koszyki for a generic allocation with a strategy, else Klasy). */
  view: AllocView | null;
  onView(view: AllocView): void;
  /** The account filter is on (the target column's title). */
  filtered: boolean;
  /** At 2/3 of the grid (default): donut 128 px + value and to-target columns. */
  wide?: boolean;
  onAddAccount(): void;
  /** Legacy account id (null = no account), old: the Import drawer for it. */
  onReconcile(accountId: number | null): void;
  onSettings(): void;
  warningsOpen: boolean;
  onWarnings(open: boolean): void;
}

interface AllocRow {
  key: string;
  name: string;
  color: ChartColor;
  now: string;
  target: string;
  drift: string;
  /** Drift out of the band (old `.warn`). */
  out: boolean;
  value: string;
  toTarget: string;
}

interface AccountAllocRow {
  key: number;
  title: string;
  color: ChartColor;
  name: string;
  share: string;
  value: string;
  snapshot: string;
  /** Stale snapshot of an imported account: the cell is a `uzgodnij` link. */
  onReconcile: (() => void) | null;
}

interface HeadCell {
  text: string;
  title?: string;
}

type AllocationBody =
  | { kind: "empty"; text: string }
  | {
      kind: "rows";
      donut: DonutProps;
      head: {
        name: string;
        now: string;
        target: HeadCell;
        drift: HeadCell;
        value: string;
        toTarget: string;
      };
      rows: AllocRow[];
      priority: { label: string; text: string; warn: boolean } | null;
    }
  | {
      kind: "accounts";
      donut: DonutProps;
      head: { name: string; now: string; value: string; snapshot: string };
      rows: AccountAllocRow[];
    };

interface WarningsLine {
  text: string;
  title?: string;
  link: string;
  onLink(): void;
}

export interface AllocationWidgetProps {
  title: string;
  wide: boolean;
  tag: { text: string; tone: "warning" | "positive"; title?: string } | null;
  viewLabel: string;
  views: [string, AllocView][];
  view: AllocView;
  onView(view: AllocView): void;
  /** The Rachunki view's controls: `ostrzezenia (n)` (null without warnings) and `+ Rachunek`. */
  accounts: {
    warnings: { text: string; title: string; onOpen(): void } | null;
    add: { text: string; onPress(): void };
  } | null;
  body: AllocationBody;
  /** The data warnings drawer (open only). */
  drawer: { title: string; onClose(): void; lines: WarningsLine[] } | null;
}

const PALETTE: ChartColor[] = [
  "inv-global",
  "inv-pl",
  "inv-bonds",
  "inv-cash",
  "inv-5",
  "inv-6",
  "inv-7",
  "inv-other",
];
const paletteAt = (k: number): ChartColor => PALETTE[k % 8] ?? "inv-other";
/** `var(--inv-pl)` (labels.ts bucketColor) -> the chart colour name `inv-pl`. */
const colorName = (cssVar: string): ChartColor =>
  cssVar.replace(/^var\(--/, "").replace(/\)$/, "") as ChartColor;
const totalK = (total: number, currency: string) =>
  total >= 1000 ? hideAmount(S.thousands(Math.round(total / 1000))) : money0(total, currency);

function accountsBody(overview: Overview, today: string, ui: AllocationUi): AllocationBody {
  const accounts = overview.accounts;
  const c = overview.base_currency;
  if (!accounts.length) return { kind: "empty", text: S.noAccounts };
  const total = accounts.reduce((s, a) => s + Math.max(0, a.value ?? 0), 0);
  const rows = accounts.map((a, k) => ({
    a,
    color: paletteAt(k),
    snap: accountSnapshot(a, today),
  }));
  return {
    kind: "accounts",
    donut: {
      label: S.accountsDonut(
        rows.map((r) => `${accountLabel(r.a, accounts)} ${pct(r.a.share ?? null)}`).join(", "),
      ),
      segments: rows.map((r) => ({
        value: Math.max(0, r.a.value ?? 0),
        color: r.color,
        name: accountLabel(r.a, accounts),
      })),
      center: { title: totalK(total, c), caption: nAccountsInv(accounts.length) },
    },
    head: { name: S.colAccount, now: S.colNow, value: S.colValueLc, snapshot: S.colSnapshot },
    rows: rows.map(({ a, color, snap }) => ({
      key: a.id,
      title: snap.title,
      color,
      name: accountLabel(a, accounts),
      share: a.share != null ? pct(a.share) : "",
      value: a.value != null ? money0(a.value, c) : "-",
      snapshot: snap.warn ? `${snap.cell} · ${S.reconcile}` : snap.cell,
      onReconcile: snap.warn ? () => ui.onReconcile(a.id) : null,
    })),
  };
}

/** DataWarnings (Portfolio.tsx:210-234): the link's count and title, the drawer's lines. */
function dataWarnings(data: InvestmentsHomeData, ui: AllocationUi) {
  const overview = data.ov.data as Overview;
  const strategy = data.strat.data ?? null;
  const fr = overview.freshness;
  const labels = new Map<string, string>(
    fr.prices.stale.map((s) => [String(s.instrument_id), s.label]),
  );
  const warnings = warningItems({
    warnings: overview.warnings,
    labels,
    accounts: overview.accounts,
    stale: fr.prices.stale,
    missingFx: fr.fx.missing,
    today: data.today,
  });
  const inactive = strategy?.inactive_rules ?? [];
  const invalid = strategy?.state === "invalid";
  const n = warnings.length + (inactive.length ? 1 : 0) + (invalid ? 1 : 0);
  if (!n) return { link: null, drawer: null };
  const title = [
    fr.fx.newest_rate ? `NBP ${dm(fr.fx.newest_rate)}` : null,
    ...fr.prices.stale.slice(0, 2).map((s) => S.priceFrom(s.label, dm(s.price_date))),
    inactive.length ? S.inactiveRules(inactive.length) : null,
    invalid ? S.strategyError : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const toSettings = () => {
    ui.onWarnings(false);
    ui.onSettings();
  };
  const lines: WarningsLine[] = [
    ...(inactive.length > 0
      ? [
          {
            text: S.inactiveRules(inactive.length),
            title: inactive.map((r) => ruleKindLabel(r.kind)).join(", "),
            link: S.fixInSettings,
            onLink: toSettings,
          },
        ]
      : []),
    ...(invalid ? [{ text: S.strategyError, link: S.settings, onLink: toSettings }] : []),
  ];
  return {
    link: { text: S.warnings(n), title, onOpen: () => ui.onWarnings(true) },
    drawer: ui.warningsOpen
      ? { title: S.dataWarnings, onClose: () => ui.onWarnings(false), lines }
      : null,
  };
}

export function allocationProps(
  data: InvestmentsHomeData,
  ui: AllocationUi,
): AllocationWidgetProps {
  const overview = data.ov.data as Overview;
  const wide = ui.wide ?? true;
  const alloc = overview.allocation;
  const generic = allocGeneric(alloc);
  const chosen: AllocView = ui.view ?? (alloc.has_strategy && generic ? "buckets" : "classes");
  const view: AllocView = chosen === "buckets" && !generic ? "classes" : chosen;
  const order = alloc.buckets.map((b) => b.bucket_id);
  const out = alloc.buckets.filter((b) => b.out_of_band).length;
  const band = alloc.band?.absolute_band_pp ?? null;
  const bandTitle = band != null ? S.band(band) : undefined;
  const below = [...alloc.buckets]
    .filter((b) => b.drift_pp < 0)
    .sort((a, b) => a.drift_pp - b.drift_pp)[0];
  const above = [...alloc.buckets]
    .filter((b) => b.drift_pp > 0)
    .sort((a, b) => b.drift_pp - a.drift_pp)[0];
  const priority = below ?? above;
  const priorityBucket = priority ? bucketGenitive(priority.bucket_id) : null;
  const priorityText =
    priority && priorityBucket
      ? priority.drift_pp < 0
        ? S.priorityGrow(priorityBucket, pp(priority.drift_pp))
        : S.priorityHold(priorityBucket, pp(priority.drift_pp))
      : S.priorityKeep;
  const c = alloc.base_currency;
  const shares = view === "classes" ? alloc.by_asset_class : alloc.by_region;
  const rows: (AllocRow & { w: number | null; v: number })[] =
    view === "buckets"
      ? [
          ...alloc.buckets.map((b) => ({
            key: b.bucket_id,
            name: bucketLabel(b.bucket_id) ?? "",
            color: colorName(bucketColor(b.bucket_id, order)),
            w: b.weight,
            now: pct(b.weight),
            target: pctTarget(b.target),
            drift: pp(b.drift_pp),
            out: !!b.out_of_band,
            v: b.value,
            value: money0(b.value, c),
            toTarget: money0(b.to_target, c, true),
          })),
          ...(alloc.unclassified?.value
            ? [
                {
                  key: "_none",
                  name: S.noBucket,
                  color: "inv-other" as const,
                  w: alloc.unclassified.weight,
                  now: pct(alloc.unclassified.weight),
                  target: "",
                  drift: "",
                  out: false,
                  v: alloc.unclassified.value,
                  value: money0(alloc.unclassified.value, c),
                  toTarget: "",
                },
              ]
            : []),
        ]
      : view === "accounts"
        ? []
        : shares.map((s, k) => ({
            key: s.key,
            name:
              view === "classes"
                ? s.key === "cash"
                  ? S.cashLc
                  : assetClass(s.key)
                : region(s.key),
            color: paletteAt(k),
            w: s.weight,
            now: pct(s.weight),
            target: "",
            drift: "",
            out: false,
            v: s.value,
            value: money0(s.value, c),
            toTarget: "",
          }));
  const views: [string, AllocView][] = [
    ...(generic ? [[S.viewBuckets, "buckets"] as [string, AllocView]] : []),
    [S.viewClasses, "classes"],
    [S.viewRegions, "regions"],
    [S.viewAccounts, "accounts"],
  ];
  const warnings = view === "accounts" ? dataWarnings(data, ui) : { link: null, drawer: null };
  let body: AllocationBody;
  if (view === "accounts") body = accountsBody(overview, data.today, ui);
  else if (!rows.length) body = { kind: "empty", text: S.noPositionsShort };
  else
    body = {
      kind: "rows",
      donut: {
        label: S.allocDonut(rows.map((r) => `${r.name} ${pct(r.w)}`).join(", ")),
        segments: rows.map((r) => ({ value: Math.max(0, r.v), color: r.color, name: r.name })),
        center: {
          title: totalK(alloc.total, c),
          caption: view === "buckets" ? nBuckets(alloc.buckets.length) : S.positions(rows.length),
        },
      },
      head: {
        name: view === "buckets" ? S.colBucket : view === "classes" ? S.colClass : S.colRegion,
        now: S.colNow,
        target: {
          text: view === "buckets" ? S.colTarget : "",
          title: view === "buckets" && ui.filtered ? S.targetWholeTitle : undefined,
        },
        drift: {
          text: view === "buckets" ? S.colDrift : "",
          title: view === "buckets" ? bandTitle : undefined,
        },
        value: S.colValueLc,
        toTarget: view === "buckets" ? S.colToTarget : "",
      },
      // The raw weight / value only feed the donut; the View reads the formatted strings.
      rows: rows.map(({ w: _w, v: _v, ...r }) => r),
      priority:
        view === "buckets"
          ? { label: S.priority, text: priorityText, warn: !!priority?.out_of_band }
          : null,
    };
  return {
    title: S.allocation,
    wide,
    tag:
      view === "buckets"
        ? out
          ? { text: S.outOfBand(out), tone: "warning", title: bandTitle }
          : { text: S.inBand, tone: "positive", title: bandTitle }
        : null,
    viewLabel: S.allocSplit,
    views,
    view,
    onView: ui.onView,
    accounts:
      view === "accounts"
        ? {
            warnings: warnings.link,
            add: { text: S.addAccount, onPress: ui.onAddAccount },
          }
        : null,
    body,
    drawer: warnings.drawer,
  };
}
