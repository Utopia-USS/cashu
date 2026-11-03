/** Stored thesis health plus an injected local valuation; pending recommendation facts are explicit. */
import { D, type DateTime, toUtc } from "@cashu/domain";
import {
  asInstrumentId,
  effectivePlan,
  type Instrument,
  type InstrumentId,
  instrumentLabel,
  openedOn,
  type plan,
  research,
  type ValuedHolding,
  type ValuedPortfolio,
} from "@cashu/domain/investments";
import type { ResearchNote } from "../research/rows.js";
import { healthByInstrument } from "../research/views.js";
import { watchlist } from "./alerts.js";
import { loadInstrument } from "./instruments.js";
import type { ThesisView } from "./journal.js";
import { instrumentGid, type Read } from "./shared.js";

export interface PendingPlan {
  readonly instrument: InstrumentId;
  readonly plan: string | null;
  readonly planAt: DateTime | null;
}
export interface PlanFactsInput {
  readonly valued: ValuedPortfolio;
  readonly now: DateTime;
  readonly only?: InstrumentId;
  readonly pendingPlan?: PendingPlan;
  /** A new note is not in the pre-append SQL view yet. */
  readonly pendingResearchNotes?: ReadonlyMap<string, ResearchNote>;
  readonly pendingTheses?: ReadonlyMap<string, ThesisView>;
  /** Complete prospective membership, captured from the watch command's actual effect. */
  readonly pendingWatched?: ReadonlySet<string>;
  readonly pendingInstruments?: ReadonlyMap<string, Instrument>;
}
export function planFacts(read: Read, input: PlanFactsInput): plan.PlanFacts[] {
  const grouped = new Map<InstrumentId, ValuedHolding[]>();
  for (const holding of input.valued.valued) {
    const root = instrumentGid(read, holding.holding.instrumentId);
    if (
      root === undefined ||
      root !== holding.holding.instrumentId ||
      holding.instrument.id !== root
    )
      throw new TypeError("noncanonical plan holding");
    const id = asInstrumentId(root);
    if (input.only === undefined || id === input.only)
      grouped.set(id, [...(grouped.get(id) ?? []), holding]);
  }
  const watched = [
    ...(input.pendingWatched ?? new Set(watchlist(read).map((row) => row.instrument))),
  ]
    .map(asInstrumentId)
    .filter((id) => !grouped.has(id) && (input.only === undefined || id === input.only));
  const ids = [...[...grouped.keys()].sort(), ...[...new Set(watched)].sort()];
  const now = toUtc(input.now);
  const health = healthByInstrument(
    read,
    ids,
    research.utcInstant(now.date, now.hour, now.minute, now.second, now.microsecond),
    input.pendingResearchNotes,
    input.pendingTheses,
  );
  return ids.flatMap((id) => {
    const inst = input.pendingInstruments?.get(id) ?? loadInstrument(read, id);
    if (inst === undefined) return [];
    const held = grouped.get(id);
    const status = health.get(id);
    if (status === undefined) throw new Error("missing plan health facts");
    let unrealized: number | null = null;
    if (
      held?.every((holding) => holding.marketValueBase !== null && holding.costBasisBase !== null)
    ) {
      let value = D("0");
      let cost = D("0");
      for (const holding of held) {
        if (holding.marketValueBase === null || holding.costBasisBase === null)
          throw new Error("unreachable plan value");
        value = value.add(holding.marketValueBase);
        cost = cost.add(holding.costBasisBase);
      }
      if (!cost.isZero()) unrealized = value.sub(cost).div(cost).toFloat();
    }
    const pending = input.pendingPlan?.instrument === id ? input.pendingPlan : undefined;
    return [
      {
        instrumentId: id,
        label: instrumentLabel(inst),
        symbol: inst.symbol,
        plan: effectivePlan(pending?.plan ?? (pending ? null : (inst.plan ?? null)), {
          held: held !== undefined,
          planAt: pending ? pending.planAt : inst.planAt,
          opened:
            held === undefined
              ? null
              : openedOn(
                  held.map((holding) => holding.holding),
                  input.valued.snapshot.realized,
                ),
        }),
        health: status.health.state,
        hasExitPlan: (status.thesis?.exitPlan ?? "").trim().length > 0,
        unrealized,
        priceStale: held?.some((holding) => holding.isStale) ?? false,
        held: held !== undefined,
      },
    ];
  });
}
