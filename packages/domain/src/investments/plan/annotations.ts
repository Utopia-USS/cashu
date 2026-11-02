/** P2/P3 annotation of already-loaded canonical subjects; no query, clock or locale lookup. */
import type { UiLang } from "../../core/i18n.js";
import type { InstrumentId } from "../domain/index.js";
import type { AnnotationSubject, InstrumentAnnotation, ViewClock } from "../views/types.js";
import { planFreshness, planInstant } from "./freshness.js";
import { instrumentHints } from "./hints.js";

export type { InstrumentAnnotation } from "../views/types.js";
/** Input collections are independently ordered by the caller's accepted canonical creation ranks. */
export function annotateSubjects(
  subjects: readonly AnnotationSubject[],
  clock: ViewClock,
  _lang: UiLang,
): ReadonlyMap<InstrumentId, InstrumentAnnotation> {
  const now = planInstant(clock.now),
    out = new Map<InstrumentId, InstrumentAnnotation>();
  for (const s of subjects) {
    const freshness = planFreshness(
      {
        plan: s.plan,
        planAt: s.planAt === null ? null : planInstant(s.planAt),
        health: s.health.state,
        notes: s.notes,
        coreChangedAt: s.coreChangedAt === null ? null : planInstant(s.coreChangedAt),
        signals: s.allOpenSignals.map((signal, order) => ({
          signalId: signal.id,
          kind: signal.kind,
          firstSeenAt: planInstant(signal.firstSeenAt),
          order,
        })),
        alerts: s.freshnessTriggeredAlerts.flatMap((alert, order) =>
          alert.lastTriggeredAt === null
            ? []
            : [
                {
                  alertId: alert.id,
                  kind: alert.kind,
                  triggeredAt: planInstant(alert.lastTriggeredAt),
                  order,
                },
              ],
        ),
      },
      now,
    );
    const hints = s.hintsWanted
      ? instrumentHints({
          held: s.held,
          health: s.health.state,
          hasThesis: s.hasThesis,
          hasExitPlan: s.hasExitPlan,
          plan: s.plan,
          predatesThesis: s.health.predatesThesis,
          signals: s.allOpenSignals,
          alerts: s.hintTriggeredAlerts.map((a, order) => ({
            alertId: a.id,
            kind: a.kind,
            title: a.title,
            order,
          })),
          weight: s.weight,
          thesisTracked: s.thesisTracked,
          freshness,
        })
      : [];
    out.set(s.instrument.id, {
      hints,
      freshness,
      plan: s.plan,
      planAt: s.planAt,
      health: s.health,
    });
  }
  return out;
}
