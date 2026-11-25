/** Source alert_dict/alert_states reads. Computing a display level never evaluates persisted state. */
import { addDays } from "@cashu/domain";
import { parseSignalSeverity } from "@cashu/domain/investments";
import * as domain from "@cashu/domain/investments/alerts";
import type { SignalPolarity } from "@cashu/domain/investments/rules";
import type { Read } from "../../query.js";
import { type MarketInput, resolveMarketInput } from "../marketInput.js";
import { alerts } from "../queries/alerts.js";
import { loadInstruments } from "../queries/instruments.js";
import { openAlertSignals } from "../queries/signals.js";
import { orderAlertRows } from "./reads.js";

export function readAlertRows(read: Read, now: string, today: string, market: MarketInput | null) {
  const rows = orderAlertRows(read, alerts(read, now));
  const instruments = loadInstruments(
    read,
    rows.flatMap((row) => (row.instrument === null ? [] : [row.instrument])),
  );
  const data = market === null ? null : resolveMarketInput(market, instruments.values());
  const signals = openAlertSignals(read);
  return rows.map((row) => {
    const instrument = row.instrument === null ? null : (instruments.get(row.instrument) ?? null);
    const signal = signals.get(row.gid) ?? null;
    let state: Readonly<Record<string, unknown>> | null = null;
    if (
      data !== null &&
      instrument !== null &&
      ["range_breakout", "volume_spike"].includes(row.kind)
    ) {
      const scope = Object.values(domain.AlertScope).find((value) => value === row.scope);
      if (scope === undefined) throw new Error("invalid stored alert scope");
      const outcome = domain.evaluateAlert(
        {
          id: row.gid,
          kind: row.kind === "range_breakout" ? "range_breakout" : "volume_spike",
          scope,
          params: row.params,
          title: row.title,
          polarity: row.polarity as SignalPolarity,
          severity: parseSignalSeverity(row.severity),
          instrument,
        },
        {
          asOf: today,
          maxPriceAgeDays: 10_000,
          bars: new Map([
            [
              instrument.id,
              data
                .series(instrument.id)
                .filter((bar) => bar.date >= addDays(today, -420) && bar.date <= today),
            ],
          ]),
        },
      ).outcome;
      const details =
        outcome.type === "fired"
          ? outcome.candidate.payload
          : outcome.type === "not_fired"
            ? outcome.details
            : null;
      if (details != null) {
        const fields =
          row.kind === "range_breakout"
            ? ["range_low", "range_high", "range_pct", "close", "currency", "window_days"]
            : ["average_volume", "volume", "ratio", "window_days"];
        const required =
          row.kind === "range_breakout" ? ["range_low", "range_high", "close"] : ["average_volume"];
        if (required.every((key) => details[key] != null))
          state = Object.fromEntries(fields.map((key) => [key, details[key] ?? null]));
      }
    }
    const [messageCode, messageParams] =
      signal === null
        ? [null, null]
        : domain.alertMessage(
            signal.kind,
            signal.payload,
            signal.message,
            instrument?.symbol ?? instrument?.name ?? null,
          );
    return {
      ...row,
      instrumentDetail: instrument,
      unit: domain.CATALOG.get(row.kind as domain.AlertKind)?.unit ?? null,
      state,
      stateUnavailable: data === null && ["range_breakout", "volume_spike"].includes(row.kind),
      signal:
        signal === null
          ? null
          : {
              gid: signal.gid,
              status: signal.status,
              message: signal.message,
              messageCode,
              messageParams,
              firstSeenAt: signal.firstSeenAt,
            },
    };
  });
}
