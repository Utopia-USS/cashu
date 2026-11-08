/** Explicit MCP labels over native investment DTOs; the existing privacy boundary remains final. */
import { daysBetween, roundFloatToInt } from "@cashu/domain";
import { mcpAccounts } from "@cashu/store/core";
import * as L from "../privacy/labels.js";
import { systemText } from "../privacy/messages.js";
import { ownerNamed } from "../providers/investments.js";
import { type ToolContext, ToolError } from "../registry.js";
import { encodeEntityRef } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";

type Context = ToolContext<NativeToolStore>;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" ? value : null);
function reads(ctx: Context) {
  if (ctx.store.investments === undefined)
    throw new ToolError("native investment reads are unavailable", "unsupported");
  return ctx.store.investments;
}
function publicText(ctx: Context, value: string | null): string | null {
  return ctx.strict && value !== null ? ctx.guard.publicName(value) : value;
}
export function reviewContext(ctx: Context): L.LabelledTree {
  const value = reads(ctx).reviewContext();
  return {
    review: {
      name: L.text(value.review.name),
      every: L.category(value.review.every),
      day: L.category(value.review.day),
      cards: value.review.cards.map(L.category),
      due: L.flag(value.review.due),
      next_on: L.date(value.review.next_on),
    },
    since: L.date(value.since),
    last_review:
      value.last_review === null
        ? null
        : {
            done_at: L.date(value.last_review.done_at),
            notes: L.text(value.last_review.notes),
            agenda: value.last_review.agenda.map((a) => ({
              card: L.category(typeof a.card === "string" ? a.card : null),
              note: L.text(typeof a.note === "string" ? a.note : null),
            })),
          },
    card_sources: Object.fromEntries(
      Object.entries(value.card_sources).map(([k, v]) => [k, L.text(v)]),
    ),
    calendar: {
      stale: L.flag(value.calendar.stale),
      events: value.calendar.events.map((e) => ({
        date: L.date(e.date),
        time: L.text(e.time),
        kind: L.category(e.kind),
        title: L.text(e.title),
        country: L.category(e.country),
        instrument_id: L.ref(
          e.instrument_id === null ? null : encodeEntityRef("instrument", e.instrument_id),
        ),
        label: L.symbol(e.label),
        held: L.flag(e.held),
      })),
    },
  };
}
export function strategyStatus(ctx: Context): L.LabelledTree {
  const st = reads(ctx).strategyStatus(),
    facts = st.facts;
  const issue = (i: (typeof st.issues)[number]) => ({
    severity: L.category(text(i.severity)),
    path: L.text(text(i.path)),
    code: L.category(text(i.code)),
    message: systemText(ctx, text(i.message)),
    line: L.count(count(i.line)),
    column: L.count(count(i.column)),
  });
  return {
    state: L.category(st.state),
    version: L.count(st.version),
    changed: L.flag(st.changed),
    errors: L.count(st.errors),
    warnings: L.count(st.warnings),
    files_present: {
      yaml: L.flag(st.files.yaml_exists),
      md: L.flag(st.files.md_exists),
      yaml_path: L.identifier(st.files.yaml),
    },
    read_error: L.flag(Boolean(st.read_error)),
    issues: st.issues.map(issue),
    inactive_rules: st.inactive_rules.map((r) => ({
      index: L.count(r.index),
      rule: L.text(r.rule_id),
      kind: L.category(r.kind),
      line: L.count(r.line),
      issues: r.issues.map(issue),
    })),
    facts:
      facts === null
        ? null
        : {
            base_currency: L.category(facts.base_currency),
            buckets: facts.buckets.map(L.category),
            targets: Object.entries(facts.targets).map(([bucket, target]) => ({
              bucket: L.category(bucket),
              target: L.pct(target),
            })),
            rules: facts.rules.map((r) => ({
              rule: L.text(r.id),
              kind: L.category(r.kind),
              severity: L.category(r.severity),
              cooldown_days: L.count(r.cooldown_days),
            })),
            horizon_years: L.count(facts.horizon_years),
            contributions:
              facts.contributions === null
                ? null
                : {
                    day_of_month: L.count(facts.contributions.day_of_month),
                    monthly_amount: L.amount(facts.contributions.monthly_amount),
                  },
            notifications: {
              immediate: facts.notifications.immediate.map(L.category),
              digest_weekday: L.category(facts.notifications.digest_weekday),
            },
          },
    base_currency_note: L.text(st.base_currency_note),
    versions: st.versions.map((v) => ({
      version: L.count(v.version),
      state: L.category(v.state),
      created_at: L.date(v.created_at),
      issues: L.count(v.issues),
    })),
  };
}
export function positions(ctx: Context): L.LabelledTree {
  const value = reads(ctx).positions();
  const labels = accountLabelsByGid(ctx);
  return {
    as_of: L.date(value.as_of),
    base_currency: L.category(value.base_currency),
    base_note: L.fixedText(
      "weight: share of the portfolio total (holdings + cash) in base currency",
    ),
    positions: value.positions.map((p) => {
      const inst = p.instrument,
        privateName = ownerNamed({
          name: inst.name,
          symbol: inst.symbol,
          assetClass: inst.asset_class,
          valuationMode: inst.valuation_mode,
          isin: inst.isin,
        });
      const dates = p.lots.map((l) => l.open_date),
        totalQ = p.lots.reduce((q, l) => q + Number(l.quantity.toString()), 0);
      const weighted =
        totalQ === 0
          ? null
          : roundFloatToInt(
              p.lots.reduce(
                (n, l) => n + Number(l.quantity.toString()) * daysBetween(l.open_date, ctx.today),
                0,
              ) / totalQ,
            );
      const freshness = inst.plan_freshness;
      return {
        instrument_id: L.ref(encodeEntityRef("instrument", inst.id)),
        symbol: privateName ? L.identifier(inst.symbol) : L.symbol(inst.symbol),
        isin: L.symbol(inst.isin),
        name: privateName ? L.identifier(inst.name) : L.text(publicText(ctx, inst.name)),
        owner_named: L.flag(privateName),
        asset_class: L.category(inst.asset_class),
        currency: L.category(inst.currency),
        region: L.category(inst.region),
        tags: inst.tags.map(L.category),
        valuation_mode: L.category(inst.valuation_mode),
        needs_classification: L.flag(inst.needs_classification),
        bucket: L.category(p.bucket),
        weight: L.pct(p.weight),
        unrealized_pct: L.pct(p.unrealized_pct),
        price_date: L.date(p.price_date),
        is_stale: L.flag(p.is_stale),
        holding_days_oldest: L.count(
          dates.length === 0 ? null : daysBetween([...dates].sort()[0] as string, ctx.today),
        ),
        holding_days_avg: L.count(weighted),
        lots: L.count(p.lots.length),
        open_signals: L.count(p.open_signals),
        has_thesis: L.flag(p.has_thesis),
        recommendation: L.category(inst.plan),
        strength: L.category(inst.strength),
        strength_basis: L.category(inst.strength_basis),
        plan_freshness:
          freshness === null
            ? null
            : {
                state: L.category(freshness.state),
                reasons: [...new Set(freshness.reasons.map((r) => r.code))].map(L.category),
              },
        hints: p.hints.map((h) => ({
          code: L.category(h.code),
          severity: L.category(h.severity),
          params: hintParams(h.params),
        })),
        accounts: p.accounts.map((a) => ({
          account: L.account(labels.get(a.account_id) ?? null),
          weight: L.pct(a.weight),
          unrealized_pct: L.pct(a.unrealized_pct),
          quantity: L.amount(a.quantity, 8),
          value: L.amount(a.value),
        })),
        quantity: L.amount(p.quantity, 8),
        price: L.amount(p.price, 8),
        value: L.amount(p.value),
        cost: L.amount(p.cost),
        realized: L.amount(p.realized),
      };
    }),
    cash: value.cash.map((c) => ({
      account: L.account(labels.get(c.account_id) ?? null),
      currency: L.category(c.currency),
      weight: L.share(c.amount_base, value.total),
      amount: L.amount(c.amount),
    })),
    total: L.amount(value.total),
  };
}
function accountLabelsByGid(ctx: Context): ReadonlyMap<string, string> {
  // Account labels are keyed by the folded store's numeric view id, never a source/Python counter.
  return new Map(
    mcpAccounts(ctx.store.read).flatMap((row) => {
      const label = ctx.accountLabels.get(row.id);
      return label === undefined ? [] : [[row.gid, label] as const];
    }),
  );
}
export function hintParams(params: Readonly<Record<string, unknown>>): {
  [key: string]: L.LabelledTree;
} {
  const out: { [key: string]: L.LabelledTree } = {};
  for (const [key, value] of Object.entries(params)) {
    if (["gain", "loss", "drawdown", "weight", "max_weight", "threshold"].includes(key))
      out[key] = L.pct(typeof value === "number" ? value : null);
    else if (["has_exit_plan", "predates_thesis"].includes(key)) out[key] = L.flag(Boolean(value));
    else if (["plan", "health", "kind", "basis"].includes(key))
      out[key] = L.category(typeof value === "string" ? value : null);
    else if (key === "alert_id")
      out[key] = L.ref(typeof value === "string" ? encodeEntityRef("alert", value) : null);
    else if (key === "reasons")
      out[key] = Array.isArray(value)
        ? value.map((v) => L.category(typeof v === "string" ? v : null))
        : [];
  }
  return out;
}
export function portfolioOverview(ctx: Context): L.LabelledTree {
  const labels = accountLabelsByGid(ctx);
  const ov = reads(ctx).overview(),
    k = ov.kpis,
    a = ov.allocation,
    f = ov.freshness,
    total = k.value.total;
  const privateIds = new Set<string>(
    reads(ctx)
      .positions()
      .positions.filter((p) =>
        ownerNamed({
          name: p.instrument.name,
          symbol: p.instrument.symbol,
          assetClass: p.instrument.asset_class,
          valuationMode: p.instrument.valuation_mode,
          isin: p.instrument.isin,
        }),
      )
      .map((p) => p.instrument.id),
  );
  const label = (id: string, text: string | null) =>
    privateIds.has(id) ? L.identifier(text) : L.text(publicText(ctx, text));
  const dist = (rows: typeof a.by_asset_class) =>
    rows.map((r) => ({
      key: L.category(r.key),
      weight: L.pct(r.weight),
      value: L.amount(r.value),
    }));
  return {
    as_of: L.date(ov.as_of),
    base_currency: L.category(ov.base_currency),
    has_strategy: L.flag(a.has_strategy),
    total: L.amount(total),
    holdings_weight: L.share(k.value.holdings, total),
    cash_weight: L.pct(k.cash.weight),
    cash_accounts: L.count(k.cash.accounts),
    unrealized_pct: L.pct(k.unrealized.pct),
    unrealized: L.amount(k.unrealized.amount),
    realized: L.amount(k.realized),
    buckets: a.buckets.map((b) => ({
      bucket: L.category(b.bucket_id),
      weight: L.pct(b.weight),
      target: L.pct(b.target),
      drift_pp: L.pct(b.drift_pp, 4),
      out_of_band: L.flag(b.out_of_band),
      band_note: L.text(b.band_note),
      instruments: L.count(b.instrument_ids.length),
      cash_history_gap: L.flag(Boolean(b.cash_history_gap)),
      value: L.amount(b.value),
      to_target: L.amount(b.to_target),
    })),
    unclassified: {
      weight: L.pct(a.unclassified?.weight ?? null),
      instruments: (a.unclassified?.instruments ?? []).map((i) => label(i.id, i.label)),
      value: L.amount(a.unclassified?.value ?? null),
    },
    by_asset_class: dist(a.by_asset_class),
    by_region: dist(a.by_region),
    band: {
      absolute_band_pp: L.pct(a.band?.absolute_band_pp ?? null, 4),
      relative_band: L.pct(a.band?.relative_band ?? null),
      min_trade_value: L.amount(a.band?.min_trade_value ?? null),
    },
    signals: {
      action: L.count(k.signals.action),
      info: L.count(k.signals.info),
      new: L.count(k.signals.new),
    },
    max_drift:
      k.max_drift === null
        ? null
        : {
            bucket: L.category(k.max_drift.bucket_id),
            drift_pp: L.pct(k.max_drift.drift_pp, 4),
            out_of_band: L.flag(k.max_drift.out_of_band),
          },
    out_of_band: L.count(k.out_of_band),
    last_run:
      k.last_run === null
        ? null
        : {
            status: L.category(k.last_run.status),
            trigger: L.category(k.last_run.trigger),
            as_of: L.date(k.last_run.as_of),
            finished_at: L.date(k.last_run.finished_at),
            new_signals: L.count(k.last_run.new_signal_ids.length),
            escalated_signals: L.count(k.last_run.escalated_signal_ids.length),
            errors: L.count(k.last_run.errors.length),
          },
    freshness: {
      newest_bar: L.date(f.prices.newest_bar),
      stale_count: L.count(f.prices.stale_count),
      stale_weight: L.pct(f.prices.stale_weight),
      stale: f.prices.stale.map((s) => ({
        label: label(s.instrument_id, s.label),
        price_date: L.date(s.price_date),
      })),
      fx_newest: L.date(f.fx.newest_rate),
      fx_missing: f.fx.missing.map(L.category),
      strategy: {
        state: L.category(f.strategy.state),
        version: L.count(f.strategy.version),
        changed: L.flag(f.strategy.changed),
        errors: L.count(f.strategy.errors),
        warnings: L.count(f.strategy.warnings),
        inactive_rules: L.count(f.strategy.inactive_rules),
      },
    },
    warnings: ov.warnings.map((w) => ({
      kind: L.category(w.kind),
      message: systemText(ctx, w.message),
    })),
    accounts: ov.accounts.map((r) => ({
      account: L.account(labels.get(r.id) ?? null),
      name: L.identifier(r.name),
      broker: L.category(r.broker),
      wrapper: L.category(r.wrapper),
      currency: L.category(r.currency),
      share: L.pct(r.share),
      value: L.amount(r.value),
      snapshot_date: L.date(r.snapshot_date),
      last_import: L.date(r.last_import?.at ?? null),
      last_import_file: L.identifier(r.last_import?.file_name ?? null),
    })),
  };
}
