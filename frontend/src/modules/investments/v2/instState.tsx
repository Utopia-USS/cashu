// The owner state behind the ticker tile's marks (design/v3/plan-badges/plan-badges.md 1, 5; spec P1 Frontend):
// thesis health per instrument from the cached research summary, whether that research is stale, and which
// instruments the profile holds (the plan label's held / watched form). Provided once at the investments root, so
// the label's call sites need no new props; without a provider (or before the summary loads) no ring is drawn and
// plan labels use the held form.
import { createContext, useContext } from "react";
import type { Hint } from "../api";
import type { HealthKey } from "./research/types";

export interface InstState {
  /** Instrument id (as a string) -> thesis health; an instrument absent from the summary has no entry. */
  health: Map<string, HealthKey>;
  /** The research behind the health map is stale (`healthStale`): no ring, the card says `research nieaktualny`. */
  stale: boolean;
  /** Held instrument ids (as strings); null = unknown (labels in the held form). */
  held: Set<string> | null;
  /** P2: instrument ids whose health rests only on research older than the thesis' last core change (faded ring). */
  pre?: Set<string>;
  /** P2: strategy hints per instrument id (positions rows, then watchlist rows): the hover card's `strategia` rows for
   * labels whose call site has no row at hand (research strip, note cards). */
  hints?: Map<string, Hint[]>;
}

export const InstStateContext = createContext<InstState>({ health: new Map(), stale: false, held: null, pre: new Set() });

export const useInstState = () => useContext(InstStateContext);

/** Whether the profile holds `id` (unknown -> true: the held form, design note 5). */
export const isHeld = (st: InstState, id: number | string) => (st.held ? st.held.has(String(id)) : true);
