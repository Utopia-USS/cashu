// The owner state behind the ticker tile's marks (ab24ab6 v2/instState.tsx + the InstState memo of Home.tsx:322-341
// + InstTile of InstLabel.tsx:29-46): thesis health per instrument from the research summary, whether that research
// is stale, the held instruments (the plan label's held / watched form), the faded ring and the strategy hints.
// Pure: built from the Home data and turned into packages/ui InstTile props.
import type { InstTileProps } from "@cashu/ui";
import type { Hint } from "@cashu/ui-logic/investments/types";
import {
  freshOf,
  type InstLike,
  instMono,
  PLAN_PATH,
  planLabel,
  ringOf,
  strengthOf,
} from "@cashu/ui-logic/investments/v2/logic";
import { healthOf, healthStale } from "@cashu/ui-logic/investments/v2/research/logic";
import type { HealthKey } from "@cashu/ui-logic/investments/v2/research/types";
import type { InvestmentsHomeData } from "../useInvestmentsHomeData.js";

export interface InstState {
  /** Instrument id (as a string) -> thesis health; an instrument absent from the summary has no entry. */
  health: Map<string, HealthKey>;
  /** The research behind the health map is stale: no ring. */
  stale: boolean;
  /** Held instrument ids (as strings); null = unknown (labels in the held form). */
  held: Set<string> | null;
  /** Ids whose health rests only on research older than the thesis (faded ring). */
  pre: Set<string>;
  /** Strategy hints per instrument id (positions rows, then watchlist rows). */
  hints: Map<string, Hint[]>;
}

/** Home.tsx:322-341: one state for every label under the page. */
export function instStateOf(data: InvestmentsHomeData): InstState {
  const positions = data.pos.data;
  const allPositions = data.allPos.data === null ? positions : data.allPos.data;
  const summary = data.research.summary;
  const health = new Map<string, HealthKey>();
  const pre = new Set<string>();
  for (const x of summary?.instruments ?? []) {
    health.set(String(x.instrument_id), healthOf(x, data.today));
    if (x.health_predates_thesis) pre.add(String(x.instrument_id));
  }
  let held: Set<string> | null = null;
  if (allPositions) {
    held = new Set(allPositions.positions.map((p) => String(p.instrument.id)));
    for (const s of data.sig.data ?? [])
      if (s.held === true && s.instrument_id != null) held.add(String(s.instrument_id));
    for (const x of summary?.instruments ?? [])
      if (x.held === true) held.add(String(x.instrument_id));
    for (const w of data.watchQ.data ?? []) if (w.held) held.add(String(w.instrument_id));
  }
  const hints = new Map<string, Hint[]>();
  for (const w of data.watchQ.data ?? [])
    if (w.hints?.length) hints.set(String(w.instrument_id), w.hints);
  for (const p of (allPositions ?? positions)?.positions ?? [])
    if (p.hints) hints.set(String(p.instrument.id), p.hints);
  return {
    health,
    stale: health.size > 0 && healthStale(data.research.runs, data.today),
    held,
    pre,
    hints,
  };
}

/** Whether the profile holds `id` (unknown -> true: the held form). */
export const isHeld = (st: InstState, id: number | string): boolean =>
  st.held ? st.held.has(String(id)) : true;

/** The tile of an instrument (old InstTile, not `plain`): monogram, plan coin (else the strength glyph), freshness
 * rim, health ring. */
export function tileOf(
  inst: InstLike,
  st: InstState,
): Pick<InstTileProps, "monogram" | "plan" | "strength" | "freshness" | "health" | "faded"> {
  const planPath = inst.plan ? PLAN_PATH[inst.plan] : undefined;
  const plan = planPath && planLabel(inst.plan, isHeld(st, inst.id)) ? planPath : null;
  const strength = strengthOf(inst.strength);
  const ring = ringOf(st.health.get(String(inst.id)) ?? null, st.stale);
  return {
    monogram: instMono(inst),
    plan,
    strength,
    freshness: plan || strength ? freshOf(inst.plan_freshness) : null,
    health: ring,
    faded: ring != null && st.pre.has(String(inst.id)),
  };
}
