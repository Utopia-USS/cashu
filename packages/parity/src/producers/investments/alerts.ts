/** Full native legacy alerts view, including fresh dynamic state from copied price bars. */
import { D, investments as inv, pyIsDigit, unicodeDecimal, utcIso } from "@cashu/domain";
import { SIGNAL_POLARITIES } from "@cashu/domain/investments/rules";
import type { InvAlertRow } from "../../sources/investments.ts";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { barsBetween, daysBefore, loadInstruments, priceBar, sid } from "./rows.ts";
import { canonicalSignalValue } from "./signals.ts";

const STATUS_ORDER: Readonly<Record<string, number>> = {
  triggered: 0,
  active: 1,
  snoozed: 2,
  muted: 3,
  expired: 4,
};
const stamp = (value: string | null): string | null => (value === null ? null : utcIso(value));
const keyId = (value: number | null): bigint | null => (value === null ? null : BigInt(value));

function numberText(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  try {
    return Number(D(String(value)).toString());
  } catch {
    return null;
  }
}

/** JSON parameters are facts; numeric integers become JS numbers only for the evaluator boundary. */
function evaluatorParams(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error("unsafe alert evaluator parameter");
    return n;
  }
  if (Array.isArray(value)) return value.map(evaluatorParams);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, evaluatorParams(v)]));
  return value;
}

function legacyAlertKey(key: string): number | null {
  if (!key.startsWith("alert:") || key.length === 6) return null;
  const tail = Array.from(key.slice(6));
  if (!tail.every((c) => pyIsDigit(c.codePointAt(0) ?? 0))) return null;
  const digits = tail.map((c) => unicodeDecimal(c.codePointAt(0) ?? 0));
  if (digits.some((d) => d < 0)) throw new Error("invalid digit-only alert reference");
  const value = Number(digits.join(""));
  if (!Number.isSafeInteger(value)) throw new Error("unsafe alert reference");
  return value;
}

function dynamicState(
  row: InvAlertRow,
  instrument: inv.Instrument | undefined,
  data: inv.alerts.AlertData,
): Readonly<Record<string, unknown>> | null {
  if (instrument === undefined || (row.kind !== "range_breakout" && row.kind !== "volume_spike"))
    return null;
  if (!["instrument", "portfolio", "bucket"].includes(row.scope))
    throw new Error("unknown stored alert scope");
  const polarity = SIGNAL_POLARITIES.find((p) => p === row.polarity);
  if (polarity === undefined) throw new Error("unknown stored alert polarity");
  const check = inv.alerts.evaluateAlert(
    {
      id: sid(row.id),
      kind: row.kind,
      scope: row.scope as inv.alerts.AlertScope,
      params: evaluatorParams(row.params) as Readonly<Record<string, unknown>>,
      title: row.title,
      polarity,
      severity: inv.parseSignalSeverity(row.severity),
      instrument,
    },
    data,
  );
  const outcome = check.outcome;
  const details =
    outcome.type === "fired"
      ? outcome.candidate.payload
      : outcome.type === "not_fired"
        ? outcome.details
        : {};
  if (row.kind === "range_breakout") {
    const low = numberText(details.range_low),
      high = numberText(details.range_high),
      close = numberText(details.close);
    if (low === null || high === null || close === null) return null;
    return {
      range_low: low,
      range_high: high,
      range_pct: details.range_pct ?? null,
      close,
      currency: details.currency ?? null,
      window_days:
        typeof details.window_days === "number"
          ? BigInt(details.window_days)
          : (details.window_days ?? null),
    };
  }
  if (details.average_volume === null || details.average_volume === undefined) return null;
  return {
    average_volume: details.average_volume,
    volume: typeof details.volume === "number" ? BigInt(details.volume) : (details.volume ?? null),
    ratio: details.ratio ?? null,
    window_days:
      typeof details.window_days === "number"
        ? BigInt(details.window_days)
        : (details.window_days ?? null),
  };
}

export function produceAlerts(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const profile of db.profiles()) {
    if (!db.enabledModules(profile.id).includes("investments")) continue;
    const rows = db.investments.storedAlerts(profile.id);
    const ids = [
      ...new Set(rows.flatMap((r) => (r.instrumentId === null ? [] : [r.instrumentId]))),
    ];
    const loaded = loadInstruments(db, profile.id, ids);
    const wanted = new Set(ids.map((i) => inv.asInstrumentId(sid(i))));
    const bars = barsBetween(
      db.investments.priceBars(ids).map(priceBar),
      wanted,
      db.asOf,
      daysBefore(db.asOf, 420),
    );
    const data: inv.alerts.AlertData = { asOf: db.asOf, bars, maxPriceAgeDays: 10_000, lang: "pl" };
    // Python iterates stored rows in SQLite source order and the latest matching row wins.
    const open = new Map<number, ReturnType<typeof db.investments.signals>[number]>();
    for (const signal of [...db.investments.signals(profile.id)].reverse()) {
      if (signal.status === "active" || signal.status === "acknowledged") {
        const key = legacyAlertKey(signal.dedupKey);
        if (key !== null) open.set(key, signal);
      }
    }
    rows.sort(
      (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.id - a.id,
    );
    const alerts = rows.map((row) => {
      const instrument =
        row.instrumentId === null
          ? undefined
          : loaded.get(inv.asInstrumentId(sid(row.instrumentId)));
      const signal = open.get(row.id);
      const [code, params] =
        signal === undefined
          ? [null, null]
          : inv.alerts.alertMessage(
              signal.kind,
              signal.payload,
              signal.message,
              instrument ? instrument.symbol || instrument.name : null,
            );
      const info = [...inv.alerts.CATALOG].find(([kind]) => kind === row.kind)?.[1];
      return {
        id: keyId(row.id),
        kind: row.kind,
        scope: row.scope,
        instrument_id: keyId(row.instrumentId),
        instrument:
          instrument === undefined
            ? null
            : {
                id: keyId(row.instrumentId),
                label: instrument.symbol || instrument.name,
                symbol: instrument.symbol,
                name: instrument.name,
                isin: instrument.isin,
                currency: instrument.currency,
                asset_class: instrument.assetClass,
                valuation_mode: instrument.valuationMode,
              },
        params: row.params,
        unit: info?.unit ?? null,
        polarity: row.polarity,
        severity: row.severity,
        title: row.title,
        note: row.note,
        tag: row.tag,
        source: row.source,
        created_by: row.createdBy,
        status: row.status,
        cooldown_days: keyId(row.cooldownDays),
        expires_at: stamp(row.expiresAt),
        snoozed_until: stamp(row.snoozedUntil),
        last_triggered_at: stamp(row.lastTriggeredAt),
        last_checked_at: stamp(row.lastCheckedAt),
        last_value: numberText(row.lastValue),
        state: dynamicState(row, instrument, data),
        signal:
          signal === undefined
            ? null
            : {
                id: keyId(signal.id),
                status: signal.status,
                message: signal.message,
                message_code: code,
                message_params: params,
                first_seen_at: stamp(signal.firstSeenAt),
              },
        created_at: stamp(row.createdAt),
        updated_at: stamp(row.updatedAt),
      };
    });
    out[db.keys.key("profiles", profile.id)] = canonicalSignalValue(
      { alerts },
      db,
      "",
      "",
      "alerts",
    );
  }
  out.alert_kinds = canonicalSignalValue(
    {
      kinds: {
        kinds: inv.alerts.catalogDicts(),
        polarities: ["positive", "negative", "neutral"],
        severities: ["info", "action"],
        statuses: Object.keys(STATUS_ORDER),
      },
    },
    db,
    "",
    "",
    "alerts",
  );
  return out;
}
