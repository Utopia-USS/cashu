/** Vault-scoped stored signals and theses; references are decoded before ownership checks. */
import { daysBetween, parseDateTime, pyStrip, pyUpper, toStorage } from "@cashu/domain";
import { effectivePlan, instrumentLabel } from "@cashu/domain/investments";
import { expr } from "@cashu/domain/investments/rules";
import * as Q from "@cashu/store/investments/queries";
import * as L from "../privacy/labels.js";
import { customCondition, customSignalMessage } from "../privacy/messages.js";
import { ownerNamed } from "../providers/investments.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import { decodeEntityRef, encodeEntityRef } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";

type Context = ToolContext<NativeToolStore>;
const timestamp = (value: string | null) => L.date(value === null ? null : Q.storedTime(value));
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numeric = (v: unknown): number | null =>
  typeof v === "boolean"
    ? Number(v)
    : typeof v === "number"
      ? v
      : typeof v === "bigint"
        ? Number(v)
        : null;
const integer = (v: unknown): number | bigint | null =>
  typeof v === "boolean"
    ? Number(v)
    : typeof v === "bigint"
      ? v
      : typeof v === "number" && Number.isInteger(v)
        ? v
        : null;
// Python isinstance(bool, int) enters the count branch, and the unchanged redactor then refuses it.
const integerLabel = (value: unknown) =>
  typeof value === "boolean" ? new L.Labelled(value, "count") : L.count(integer(value));
function privateInstrument(inst: ReturnType<typeof Q.loadInstrument>): boolean {
  return inst !== undefined && ownerNamed(inst);
}
function publicName(ctx: Context, value: string | null): string | null {
  return ctx.strict ? ctx.guard.publicName(value) : value;
}
export function profileInstrument(ctx: Context, value: string): string {
  const owned = Q.vaultInstrumentGids(ctx.store.read),
    wanted = pyStrip(value);
  if (wanted.startsWith("instrument:")) {
    let gid: string;
    try {
      gid = decodeEntityRef("instrument", wanted);
    } catch {
      throw new ToolError("no such instrument in this profile (see positions)", "not_found");
    }
    const root = Q.instrumentGid(ctx.store.read, gid);
    if (root !== undefined && owned.has(root)) return root;
  } else {
    const matches = [...Q.loadInstruments(ctx.store.read, owned).values()].filter(
      (i) =>
        pyUpper(i.symbol ?? "") === pyUpper(wanted) || pyUpper(i.isin ?? "") === pyUpper(wanted),
    );
    if (matches.length === 1 && matches[0] !== undefined) return matches[0].id;
    if (matches.length > 1)
      throw new ToolError("several instruments match; pass the instrument_id from positions");
  }
  throw new ToolError("no such instrument in this profile (see positions)", "not_found");
}
export function theses(ctx: Context, args: ToolArgs): L.LabelledTree {
  const iid =
    typeof args.instrument === "string" && args.instrument
      ? profileInstrument(ctx, args.instrument)
      : undefined;
  const all = Q.theses(ctx.store.read, iid),
    held = all.length ? Q.heldSince(ctx.store.read, ctx.today) : new Map<string, string | null>(),
    watched = new Set(all.length ? Q.watchlist(ctx.store.read).map((w) => w.instrument) : []);
  // A closed position's thesis (neither held nor watched now) stays stored but is out of the review
  // and research scope: listed only on request or for that one instrument, marked `closed`.
  const position = (instrument: string) =>
    held.has(instrument) ? "held" : watched.has(instrument) ? "watched" : "closed";
  const rows =
    iid !== undefined || args.include_closed === true
      ? all
      : all.filter((r) => position(r.instrument) !== "closed");
  return {
    theses: rows.map((r) => {
      const inst = Q.loadInstrument(ctx.store.read, r.instrument),
        privateName = privateInstrument(inst);
      return {
        thesis_id: L.ref(encodeEntityRef("thesis", r.gid)),
        instrument_id: L.ref(encodeEntityRef("instrument", r.instrument)),
        symbol: privateName ? L.identifier(inst?.symbol ?? null) : L.symbol(inst?.symbol ?? null),
        name: privateName
          ? L.identifier(inst?.name ?? null)
          : L.text(publicName(ctx, inst?.name ?? null)),
        position: L.category(position(r.instrument)),
        entry_type: L.category(r.entryType),
        thesis: L.text(r.thesis),
        invalidation: L.text(r.invalidation),
        exit_plan: L.text(r.exitPlan),
        size_plan: L.text(r.sizePlan),
        recommendation: L.category(
          inst === undefined
            ? null
            : effectivePlan(inst.plan, {
                held: held.has(r.instrument),
                planAt: inst.planAt,
                opened: held.get(r.instrument) ?? null,
              }),
        ),
        reviewed_at: timestamp(r.reviewedAt),
        created_at: timestamp(r.createdAt),
        updated_at: timestamp(r.updatedAt),
      };
    }),
  };
}
const MEASURES: Readonly<Record<string, readonly [string, string, string]>> = {
  allocation_drift: ["drift_pp", "absolute_band_pp", "pp"],
  position_concentration: ["weight", "max_weight", "ratio"],
  loss_from_cost: ["unrealized_pct", "threshold", "ratio"],
  gain_from_cost: ["unrealized_pct", "threshold", "ratio"],
  drawdown_from_high: ["drawdown", "threshold", "ratio"],
  tagged_weight: ["weight", "max_weight", "ratio"],
};
function measure(
  ctx: Context,
  kind: string,
  p: Readonly<Record<string, unknown>>,
  privateName: boolean,
): Record<string, L.LabelledTree> {
  const fields = MEASURES[kind];
  if (fields !== undefined)
    return {
      measured: L.pct(numeric(p[fields[0]])),
      threshold: L.pct(numeric(p[fields[1]])),
      unit: L.category(fields[2]),
    };
  if (kind === "cash_level")
    return {
      measured: L.pct(numeric(p.cash_weight)),
      threshold: L.pct(numeric(p[p.direction === "below_min" ? "min_weight" : "max_weight"])),
      unit: L.category("ratio"),
    };
  if (kind === "contribution_gap")
    return {
      measured: integerLabel(p.days_since_last_deposit),
      threshold: L.count((numeric(p.period_days) ?? 0) + (numeric(p.grace_days) ?? 0) || null),
      unit: L.category("days"),
    };
  if (kind === "alert:range_breakout")
    return {
      measured: L.pct(numeric(p.range_pct)),
      threshold: L.pct(numeric(p.max_range_pct)),
      unit: L.category("ratio"),
      breakout: L.pct(numeric(p.breakout_pct)),
    };
  if (kind === "alert:volume_spike")
    return {
      measured: L.pct(numeric(p.ratio)),
      threshold: L.pct(numeric(p.multiple)),
      unit: L.category("multiple"),
    };
  if (kind === "custom" || kind === "alert:custom") {
    const values: L.LabelledTree[] = [];
    if (p.values !== null && typeof p.values === "object" && !Array.isArray(p.values))
      for (const [label, value] of Object.entries(p.values)) {
        const unit = expr.METRICS.get(label.split("(")[0] ?? "")?.unit;
        if ((unit === expr.Unit.RATIO || unit === expr.Unit.PP) && numeric(value) !== null)
          values.push({
            metric: L.text(label),
            measured: L.pct(numeric(value)),
            unit: L.category(unit),
          });
        else if ((unit === expr.Unit.DAYS || unit === expr.Unit.COUNT) && integer(value) !== null)
          values.push({
            metric: L.text(label),
            measured: integerLabel(value),
            unit: L.category(unit),
          });
        else if (typeof value === "boolean")
          values.push({ metric: L.text(label), measured: L.flag(value), unit: L.category("flag") });
      }
    return {
      condition: customCondition(ctx, text(p.when), undefined, { privatePrices: privateName }),
      values,
    };
  }
  return {};
}
export function signals(ctx: Context, args: ToolArgs): L.LabelledTree {
  const status = typeof args.status === "string" ? args.status : "open",
    all = Q.allSignals(ctx.store.read);
  let rows = all.filter(
    (r) =>
      (status !== "open" && status !== "history") ||
      (status === "history" ? ["resolved", "expired"] : ["active", "acknowledged"]).includes(
        r.status,
      ),
  );
  const now = new Date(ctx.store.now()).toISOString(),
    snoozed = (r: Q.SignalView) =>
      r.snoozedUntil !== null &&
      toStorage(parseDateTime(r.snoozedUntil)) > toStorage(parseDateTime(now));
  if (status === "open")
    rows = rows.sort(
      (a, b) =>
        Number(snoozed(a)) - Number(snoozed(b)) ||
        Number(a.status !== "active") - Number(b.status !== "active") ||
        (a.severity === "action" ? 0 : a.severity === "info" ? 1 : 9) -
          (b.severity === "action" ? 0 : b.severity === "info" ? 1 : 9),
    );
  return {
    status: L.category(status),
    signals: rows.map((r) => {
      const p = r.payload,
        inst = r.instrument === null ? undefined : Q.loadInstrument(ctx.store.read, r.instrument),
        privateName = privateInstrument(inst);
      const scope: L.LabelledTree =
        r.instrument !== null
          ? {
              type: L.category("instrument"),
              instrument_id: L.ref(encodeEntityRef("instrument", r.instrument)),
              symbol: privateName ? L.identifier(text(p.symbol)) : L.symbol(text(p.symbol)),
              label: privateName
                ? L.identifier(inst === undefined ? null : instrumentLabel(inst))
                : L.text(publicName(ctx, inst === undefined ? null : instrumentLabel(inst))),
            }
          : p.bucket_id
            ? { type: L.category("bucket"), bucket: L.category(text(p.bucket_id)) }
            : { type: L.category("portfolio") };
      return {
        signal_id: L.ref(encodeEntityRef("signal", r.gid)),
        rule: L.text(
          r.ruleId.startsWith("alert:") &&
            (Q.alertByGid(ctx.store.read, r.ruleId.slice(6), now) !== undefined ||
              Q.deletedAlert(ctx.store.read, r.ruleId.slice(6), now) !== undefined)
            ? encodeEntityRef("alert", r.ruleId.slice(6))
            : r.ruleId,
        ),
        kind: L.category(r.kind),
        severity: L.category(r.severity),
        status: L.category(r.status),
        polarity: L.category(r.polarity),
        source: L.category(
          r.ruleId.startsWith("alert:")
            ? "alert"
            : r.ruleId.startsWith("plan:")
              ? "plan"
              : r.ruleId.startsWith("research:")
                ? "research"
                : "rule",
        ),
        snoozed_until: timestamp(r.snoozedUntil),
        scope,
        ...measure(ctx, r.kind, p, privateName),
        direction: L.category(text(p.direction)),
        message:
          r.kind === "custom" || r.kind === "alert:custom"
            ? customSignalMessage(ctx, r.message, text(p.when), undefined, {
                privatePrices: privateName,
              })
            : L.text(r.message),
        first_seen: timestamp(r.firstSeenAt),
        last_seen: timestamp(r.lastSeenAt),
        age_days: L.count(daysBetween(r.firstSeenAt.slice(0, 10), ctx.today)),
        acknowledged: timestamp(r.acknowledgedAt),
        closed: timestamp(r.closedAt),
        decisions: Q.decisions(ctx.store.read, { signal: r.gid }).map((d) => ({
          action: L.category(d.action),
          reason: L.text(d.reason),
          created_at: timestamp(d.createdAt),
        })),
      };
    }),
  };
}
