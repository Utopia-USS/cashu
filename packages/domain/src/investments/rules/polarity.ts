/**
 * Signal polarity (`rules/polarity.py`): whether a finding is an opportunity, a risk or just
 * information. Each rule kind declares a default; a strategy rule may override it with `polarity:`.
 * Polarity never changes when or whether a rule fires; it only tells the UI how to present the signal.
 */

type Values<T> = T[keyof T];

export const SignalPolarity = Object.freeze({
  /** An opportunity per the owner's own rules (a dip tranche reached, a gain target met). */
  POSITIVE: "positive",
  /** A risk or something to review (a loss from cost, concentration, cash or deposit gaps). */
  NEGATIVE: "negative",
  /** Information or a plain review item (allocation drift out of band). */
  NEUTRAL: "neutral",
} as const);
export type SignalPolarity = Values<typeof SignalPolarity>;
/** Every polarity in declaration order (Python `list(SignalPolarity)`). */
export const SIGNAL_POLARITIES: readonly SignalPolarity[] = Object.freeze(
  Object.values(SignalPolarity),
);
