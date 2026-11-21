/**
 * The position strength per instrument: the research agent's assessment of how well the thesis of a
 * held position (or a watched entry) holds up given research, progress and environment.
 *
 * It is NOT a trade call. The model recommendation (`plan.ts`) is optional next to it: an agent that
 * is willing to state buy / hold / sell adds one, an agent that is not gives only the strength.
 *
 * Identifiers say `positionStrength` / `strengthBasis` because research notes already carry a
 * `strength` (1-3); the wire and MCP fields are `strength`, `strength_basis`, `strength_reason`,
 * `strength_at`.
 *
 * | strength  | allowed bases                                          |
 * |-----------|--------------------------------------------------------|
 * | `strong`  | on_track, undermined, environment_against, no_progress |
 * | `neutral` | on_track, undermined, environment_against, no_progress |
 * | `weak`    | fulfilled, undermined, environment_against, no_progress |
 *
 * (`fulfilled` only with `weak`, `on_track` never with `weak`.)
 */

import { BUY_PLANS } from "./plan.js";

export const POSITION_STRENGTHS = Object.freeze(["strong", "neutral", "weak"] as const);
export type PositionStrength = (typeof POSITION_STRENGTHS)[number];

export const STRENGTH_BASES = Object.freeze([
  "on_track",
  "fulfilled",
  "undermined",
  "environment_against",
  "no_progress",
] as const);
export type StrengthBasis = (typeof STRENGTH_BASES)[number];

/** Plans that contradict a `strong` strength (`reduce`, `exit_asap`). */
const SELL_PLANS: ReadonlySet<string> = new Set(["reduce", "exit_asap"]);

export function isPositionStrength(value: unknown): value is PositionStrength {
  return typeof value === "string" && (POSITION_STRENGTHS as readonly string[]).includes(value);
}

export function isStrengthBasis(value: unknown): value is StrengthBasis {
  return typeof value === "string" && (STRENGTH_BASES as readonly string[]).includes(value);
}

/** Whether `basis` may justify `strength`: `fulfilled` only with weak, `on_track` never with weak. */
export function strengthAllowed(strength: PositionStrength, basis: StrengthBasis): boolean {
  if (basis === "fulfilled") return strength === "weak";
  if (basis === "on_track") return strength !== "weak";
  return true;
}

/**
 * Whether an optional recommendation agrees with the strength: buy / buy_asap never with weak,
 * reduce / exit_asap never with strong. No plan always agrees.
 */
export function planVsStrength(plan: string | null, strength: PositionStrength): boolean {
  if (plan === null) return true;
  if (strength === "weak" && BUY_PLANS.has(plan)) return false;
  if (strength === "strong" && SELL_PLANS.has(plan)) return false;
  return true;
}
