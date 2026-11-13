// How a signal reads on the phone. The kinds whose payload carries the facts get a catalog sentence with
// the instrument's name and the values in the device locale; every other kind keeps the engine's text
// (a free-form message with no structured facts to rebuild it from).
import { Decimal } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { S } from "./signalText.strings";

/** The part of a store signal row the sentence reads. */
export interface SignalTextRow {
  readonly kind: string;
  readonly message: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Who the signal is about: the instrument's display name and its trading currency, if known. */
export interface SignalSubject {
  readonly name: string;
  readonly currency: string | null;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function decimal(value: unknown): Decimal | null {
  if (typeof value === "number") return Number.isFinite(value) ? Decimal.fromFloat(value) : null;
  if (typeof value !== "string") return null;
  try {
    return Decimal.parse(value);
  } catch {
    return null;
  }
}

/** A ratio as a percent with one decimal, or none for a whole percent (a limit of 5%). */
function pct(ratio: number, locale: string, trim = false): string {
  const value = Decimal.fromFloat(Math.abs(ratio));
  const whole = trim && Number.isInteger(Math.round(Math.abs(ratio) * 1e6) / 1e4);
  return formatDecimalValue(value, locale, { percent: true, fractionDigits: whole ? 0 : 1 }).text;
}

export function signalText(row: SignalTextRow, subject: SignalSubject, locale: string): string {
  const p = row.payload;
  switch (row.kind) {
    case "alert:change_pct": {
      const change = num(p.change);
      const days = num(p.window_days);
      const from = decimal(p.from_close);
      const to = decimal(p.close);
      if (change === null || days === null || from === null || to === null) break;
      const money = (v: Decimal) =>
        formatDecimalValue(
          v,
          locale,
          subject.currency === null ? {} : { currency: subject.currency },
        ).text;
      return (change < 0 ? S.fell : S.rose)(
        subject.name,
        pct(change, locale),
        days,
        money(from),
        money(to),
      );
    }
    case "position_concentration": {
      const weight = num(p.weight);
      const limit = num(p.max_weight);
      if (weight === null || limit === null) break;
      return S.concentration(subject.name, pct(weight, locale), pct(limit, locale, true));
    }
  }
  return row.message;
}
