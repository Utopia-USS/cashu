/** Editable decision suggestions and estimates from Signals.tsx, never orders or bookings. */
import { D, type Decimal, ZERO } from "../../decimal.js";
export type DecisionChoice = "none" | "buy" | "sell" | "later";
export interface DecisionSignalFact {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
function decimal(value: unknown): Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    return D(String(value));
  } catch {
    return null;
  }
}
export function decisionChoice(signal: DecisionSignalFact | null): DecisionChoice {
  if (signal === null) return "none";
  const kind = signal.kind.startsWith("alert:")
    ? String(signal.payload.alert_kind ?? "")
    : signal.kind;
  if (["drawdown_from_high", "loss_from_cost", "price_below"].includes(kind)) return "buy";
  if (["gain_from_cost", "position_concentration", "price_above"].includes(kind)) return "sell";
  if (kind === "allocation_drift")
    return decimal(signal.payload.drift_pp)?.gt(ZERO) ? "sell" : "buy";
  return "none";
}
export function decisionSuggestion(input: {
  readonly signal: DecisionSignalFact | null;
  readonly position: {
    readonly quantity: Decimal;
    readonly price: Decimal | null;
    readonly priceCurrency: string;
  } | null;
  readonly total: Decimal;
  readonly base: string;
}) {
  const { signal, position, total, base } = input;
  const choice = decisionChoice(signal);
  let quantity: Decimal | null = null;
  let quantityUnavailable: "currency_mismatch" | null = null;
  if (
    position?.price !== null &&
    position !== null &&
    !position.price.isZero() &&
    signal !== null
  ) {
    if (signal.kind === "position_concentration") {
      // Legacy divides a base-currency excess by quote-currency price. Never invent an FX rate.
      if (position.priceCurrency !== base) quantityUnavailable = "currency_mismatch";
      else {
        const weight = decimal(signal.payload.weight),
          maximum = decimal(signal.payload.max_weight);
        if (weight !== null && maximum !== null) {
          const over = weight.sub(maximum).mul(total);
          if (over.gt(ZERO)) {
            const rounded = over.div(position.price).quantize(0, "ROUND_CEILING");
            quantity = rounded.lt(D("1")) ? D("1") : rounded;
          }
        }
      }
    } else if (choice === "buy") {
      // Positive Math.round is half-up; Python Decimal's default half-even is different at .5.
      const rounded = position.quantity.div(D("3")).quantize(0, "ROUND_HALF_UP");
      quantity = rounded.lt(D("1")) ? D("1") : rounded;
    }
  }
  return {
    choice,
    quantity,
    quantityUnavailable,
    price: position?.price ?? null,
    currency: position?.priceCurrency ?? base,
  };
}
export function decisionEstimate(input: {
  readonly side: "buy" | "sell";
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly currency: string;
  readonly base: string;
  readonly total: Decimal;
  /** Only an actual generic bucket may expose target/drift. */
  readonly bucket: {
    readonly value: Decimal;
    readonly target: number;
    readonly driftPp: number;
    readonly generic: boolean;
  } | null;
}) {
  const { quantity, price, bucket } = input;
  if (quantity === null || price === null || !quantity.gt(ZERO) || !price.gt(ZERO)) return null;
  const amount = quantity.mul(price);
  if (bucket === null || !bucket.generic || input.total.isZero() || input.currency !== input.base)
    return { amount, currency: input.currency, allocation: null };
  const after = (input.side === "buy" ? bucket.value.add(amount) : bucket.value.sub(amount)).div(
    input.total,
  );
  const drift = after.sub(D(String(bucket.target))).mul(D("100"));
  return {
    amount,
    currency: input.currency,
    allocation: {
      afterWeight: after.toFloat(),
      target: bucket.target,
      driftPp: drift.toFloat(),
      grows: drift.abs().gt(D(String(Math.abs(bucket.driftPp))).add(D("0.000000001"))),
    },
  };
}
