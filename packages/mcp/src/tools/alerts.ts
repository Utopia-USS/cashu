/** Labelled alert projections and local alert writes, independent of network services. */
import { addDays, D, Decimal, parseDateTime } from "@cashu/domain";
import {
  alerts as A,
  type Instrument,
  instrumentLabel,
  market,
  parseSignalSeverity,
} from "@cashu/domain/investments";
import { didYouMean } from "@cashu/domain/investments/rules";
import { loadStrategy, strategyDigest } from "@cashu/domain/investments/strategy";
import { investmentsCommands as C, defineCommand, refuse } from "@cashu/store";
import * as Q from "@cashu/store/investments/queries";
import { mcpAlertRows } from "@cashu/store/investments/services";
import * as L from "../privacy/labels.js";
import { customCondition, customSignalMessage } from "../privacy/messages.js";
import { ownerNamed } from "../providers/investments.js";
import { type ToolArgs, ToolError } from "../registry.js";
import {
  type Context,
  capture,
  currentStrategyFiles,
  execute,
  instrument,
  reference,
} from "./investmentWriteSupport.js";
import * as F from "./researchLabels.js";

const KINDS = [
  "price_above",
  "price_below",
  "change_pct",
  "drawdown_from_high",
  "new_high",
  "sma_cross",
  "weight_above",
  "weight_below",
  "custom",
  "range_breakout",
  "volume_spike",
];
const ALERT_NOTE =
  "alerts are conditions on stored prices and weights, checked by the daily run; a triggered alert is a signal (rule alert:<id>) with the alert's polarity and severity; threshold and weights are fractions (0.1 = 10%), levels are in the instrument's currency; range_breakout: max_range_pct and range_pct are fractions, state gives the range of the last window; volume_spike: multiple, last_value and state.ratio are multiples of the average volume (2.5 = 2.5x)";
export function instrumentFields(
  ctx: Context,
  id: string | null,
  prospective?: Instrument,
): L.LabelledTree {
  if (prospective && prospective.id !== id)
    throw new Error("prospective instrument binding mismatch");
  const inst = id === null ? undefined : (Q.loadInstrument(ctx.store.read, id) ?? prospective);
  if (!inst) return { instrument_id: L.ref(null) };
  const privateName = ownerNamed(inst);
  return {
    instrument_id: F.ref("instrument", id),
    symbol: privateName ? L.identifier(inst.symbol) : L.symbol(inst.symbol),
    isin: L.symbol(inst.isin),
    label: privateName
      ? L.identifier(instrumentLabel(inst))
      : L.text(ctx.strict ? ctx.guard.publicName(instrumentLabel(inst)) : instrumentLabel(inst)),
    currency: L.category(inst.currency),
    owner_named: L.flag(privateName),
  };
}
const numeric = (v: unknown) =>
  v instanceof Decimal
    ? v
    : v === undefined || v === null
      ? null
      : typeof v === "number" || typeof v === "bigint"
        ? v
        : typeof v === "string"
          ? D(v)
          : null;
export const price = (v: unknown, privateName: boolean) =>
  privateName ? L.amount(numeric(v), 8) : L.level(numeric(v));
function alertRow(ctx: Context, row: Q.AlertView): L.LabelledTree {
  const inst =
      row.instrument === null ? undefined : Q.loadInstrument(ctx.store.read, row.instrument),
    privateName = inst !== undefined && ownerNamed(inst);
  const params: Record<string, L.LabelledTree> = {};
  for (const key of [
    "level",
    "threshold",
    "window_days",
    "direction",
    "max_range_pct",
    "multiple",
    "bucket",
    "expression",
  ]) {
    if (!(key in row.params)) continue;
    const value = row.params[key];
    params[key] =
      key === "level"
        ? price(value, privateName)
        : ["threshold", "max_range_pct", "multiple"].includes(key)
          ? L.pct(numeric(value))
          : key === "window_days"
            ? F.count(value)
            : key === "expression"
              ? customCondition(ctx, typeof value === "string" ? value : null, undefined, {
                  privatePrices: privateName,
                })
              : F.category(value);
  }
  const signal = Q.openSignalOfKey(ctx.store.read, C.alertRuleId(row.gid));
  const info = A.CATALOG.get(row.kind as A.AlertKind);
  let state: L.LabelledTree = null;
  if (inst && ["range_breakout", "volume_spike"].includes(row.kind)) {
    const series =
      ctx.store.prices === null
        ? (ctx.store.investmentWrites?.alertBars(inst.id) ?? [])
        : market.cachedMarketData(ctx.store.prices, [inst]).series(inst.id);
    const checked = A.evaluateAlert(
      {
        id: row.gid,
        kind: row.kind as A.AlertKind,
        scope: row.scope as A.AlertScope,
        params: row.params,
        title: row.title,
        polarity: row.polarity as "positive" | "negative" | "neutral",
        severity: parseSignalSeverity(row.severity),
        instrument: inst,
      },
      {
        asOf: ctx.today,
        bars: new Map([
          [
            inst.id,
            series.filter((b) => b.date >= addDays(ctx.today, -420) && b.date <= ctx.today),
          ],
        ]),
        maxPriceAgeDays: 10000,
      },
    );
    const details =
      checked.outcome.type === "fired"
        ? checked.outcome.candidate.payload
        : checked.outcome.type === "not_fired"
          ? checked.outcome.details
          : {};
    if (
      row.kind === "range_breakout" &&
      details.range_low != null &&
      details.range_high != null &&
      details.close != null
    )
      state = {
        range_low: price(details.range_low, privateName),
        range_high: price(details.range_high, privateName),
        range_pct: L.pct(numeric(details.range_pct)),
        window_days: F.count(details.window_days),
      };
    if (row.kind === "volume_spike" && details.average_volume != null)
      state = { ratio: L.pct(numeric(details.ratio)), window_days: F.count(details.window_days) };
  }
  return {
    alert_id: F.ref("alert", row.gid),
    kind: L.category(row.kind),
    scope: L.category(row.scope),
    instrument: instrumentFields(ctx, row.instrument),
    params,
    unit: L.category(info?.unit ?? null),
    polarity: L.category(row.polarity),
    severity: L.category(row.severity),
    status: L.category(row.status),
    source: L.category(row.source),
    created_by: L.category(row.createdBy),
    title: L.text(row.title),
    note: L.text(row.note),
    tag: L.text(row.tag),
    cooldown_days: L.count(row.cooldownDays),
    expires_at: F.date(row.expiresAt),
    snoozed_until: F.date(row.snoozedUntil),
    last_triggered_at: F.date(row.lastTriggeredAt),
    last_checked_at: F.date(row.lastCheckedAt),
    last_value:
      info?.unit === "price"
        ? price(row.lastValue, privateName)
        : info?.unit === "ratio"
          ? L.pct(numeric(row.lastValue))
          : L.pct(null),
    state,
    created_at: F.date(row.createdAt),
    signal:
      signal === undefined
        ? null
        : {
            signal_id: F.ref("signal", signal.gid),
            status: L.category(signal.status),
            message:
              row.kind === "custom"
                ? customSignalMessage(
                    ctx,
                    signal.message,
                    typeof row.params.expression === "string" ? row.params.expression : null,
                    undefined,
                    { privatePrices: privateName },
                  )
                : L.text(signal.message),
          },
  };
}
const limits = (ctx: Context, plus = 0) => ({
  agent_live: L.count(
    Q.liveAgentAlerts(ctx.store.read, parseDateTime(new Date(ctx.store.now()).toISOString())) +
      plus,
  ),
  agent_max: L.count(50),
});
export function alerts(ctx: Context, args: ToolArgs): L.LabelledTree {
  const statuses =
    args.status === undefined || args.status === "live"
      ? new Set(["active", "triggered", "snoozed"])
      : args.status === "all"
        ? null
        : new Set([String(args.status)]);
  const rows = mcpAlertRows(ctx.store.read, parseDateTime(new Date(ctx.store.now()).toISOString()));
  const tags = new Map<string, number>();
  for (const row of rows) if (row.tag) tags.set(row.tag, (tags.get(row.tag) ?? 0) + 1);
  return {
    alerts: rows
      .filter((r) => statuses === null || statuses.has(r.status))
      .map((r) => alertRow(ctx, r)),
    tags_in_use: [...tags]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([tag, count]) => ({ tag: L.text(tag), count: L.count(count) })),
    limits: limits(ctx),
    kinds: KINDS.map(L.category),
    note: L.fixedText(ALERT_NOTE),
  };
}
export async function addAlert(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const target = args.instrument ? instrument(ctx, args.instrument, true) : null;
  let valid: A.ValidatedAlert;
  try {
    valid = A.validateAlert(String(args.kind), args.params, {
      scope: args.scope,
      hasInstrument: target !== null,
    });
    A.validateText(args.title, args.note ?? null);
    A.validateTag(args.tag ?? null);
  } catch (error) {
    if (error instanceof A.AlertValidationError) throw new ToolError(error.message);
    throw error;
  }
  let command = C.createAlert;
  if (valid.bucketRefs.length > 0) {
    const { files, base } = currentStrategyFiles(ctx);
    const loaded = base.yaml === null ? null : loadStrategy(base.yaml, base.md);
    const config = loaded?.config ?? null;
    const buckets = config?.allocation.buckets.map((bucket) => bucket.id) ?? [];
    if (buckets.length === 0)
      throw new ToolError("bucket alerts need a strategy with buckets (strategy.yaml)");
    for (const ref of valid.bucketRefs)
      if (!buckets.includes(ref))
        throw new ToolError(
          `Unknown bucket "${ref}"${didYouMean(ref, buckets)}; strategy buckets: ${buckets.join(", ")}`,
        );
    const source = C.createAlertWithBuckets(new Set(buckets));
    const digest = strategyDigest(base.yaml ?? "", base.md);
    command = defineCommand({
      id: "investments.mcp.createBucketAlert",
      input: source.input,
      run(child, input) {
        if (child.vault !== files.vault || !files.isCurrent())
          return refuse("file_authority_unavailable");
        const current = files.read();
        if (!files.isCurrent() || strategyDigest(current.yaml ?? "", current.md) !== digest)
          return refuse("base_changed");
        return source.run(child, input);
      },
    });
  }
  const out = await execute(ctx, capture(command), {
    kind: args.kind,
    params: args.params,
    polarity: args.polarity,
    severity: args.severity,
    title: args.title,
    instrument: target,
    note: args.note,
    tag: args.tag,
    cooldownDays: args.cooldown_days,
    expiresInDays: args.expires_in_days,
    scope: args.scope,
    source: "agent",
    createdBy: "mcp",
  });
  const effect = out.effects.find((e) => e.type === "alert.created");
  if (!effect) throw new Error("alert effect missing");
  const d = effect.data,
    at = new Date(ctx.store.now()).toISOString();
  const row: Q.AlertView = {
    gid: effect.gid,
    instrument: target,
    kind: String(d.kind),
    scope: String(d.scope),
    params: F.object(d.params),
    title: String(d.title),
    note: typeof d.note === "string" ? d.note : null,
    tag: typeof d.tag === "string" ? d.tag : null,
    polarity: String(d.polarity),
    severity: String(d.severity),
    source: "agent",
    createdBy: "mcp",
    status: "active",
    cooldownDays: typeof d.cooldownDays === "number" ? d.cooldownDays : null,
    expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null,
    snoozedUntil: null,
    lastTriggeredAt: null,
    lastCheckedAt: null,
    lastValue: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  return {
    alert: alertRow(ctx, row),
    limits: limits(ctx, 1),
    note: L.fixedText(
      "created as active (source agent); the daily run checks it, the owner sees it badged in the app and can mute or delete it",
    ),
  };
}
export async function muteAlert(ctx: Context, args: ToolArgs): Promise<L.LabelledTree> {
  const id = reference("alert", args.id);
  if (!Q.alertByGid(ctx.store.read, id, new Date(ctx.store.now()).toISOString()))
    throw new ToolError("no such alert in this profile (see alerts)", "not_found");
  await execute(ctx, C.updateAlert, { alert: id, changes: { status: "muted" } });
  return { alert_id: F.ref("alert", id), status: L.category("muted") };
}
