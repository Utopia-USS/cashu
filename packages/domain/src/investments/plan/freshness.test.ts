/** Actual Python freshness table calls; canonical refs are synthetic fixture identities only. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { formatInstant, type ScoredNote } from "../research/index.js";
import { type FreshnessFacts, planFreshness, planInstant } from "./freshness.js";

interface Note {
  id: number;
  kind: string;
  polarity: string;
  strength: number;
  thesis_relation: string;
  observed_at: string;
  created_at: string;
  expires_at: string;
  dismissed_at: string | null;
  thesis_field?: string | null;
}
interface Input {
  facts: {
    plan: string | null;
    plan_at: string | null;
    health: string;
    notes: Note[];
    core_changed_at: string | null;
    signals: { signal_id: string; kind: string; first_seen_at: string; order: number }[];
    alerts: { alert_id: string; kind: string; triggered_at: string; order: number }[];
  };
  now: string;
}
const cases = JSON.parse(
  readFileSync(new URL("./fixtures/freshness.json", import.meta.url), "utf8"),
) as { cases: readonly [Input, unknown][] };
const at = (value: string) => planInstant(parseDateTime(value));
it.each(cases.cases)("matches actual Python freshness table %#", (r, expected) => {
  const f = r.facts;
  const facts: FreshnessFacts = {
    plan: f.plan,
    planAt: f.plan_at === null ? null : at(f.plan_at),
    health: f.health,
    notes: f.notes.map((n) => ({
      id: `note:${n.id}`,
      scored: {
        id: n.id,
        kind: n.kind,
        polarity: n.polarity,
        strength: n.strength,
        thesisRelation: n.thesis_relation,
        observedAt: at(n.observed_at),
        createdAt: at(n.created_at),
        expiresAt: at(n.expires_at),
        dismissedAt: n.dismissed_at === null ? null : at(n.dismissed_at),
        thesisField: n.thesis_field,
      } satisfies ScoredNote,
    })),
    coreChangedAt: f.core_changed_at === null ? null : at(f.core_changed_at),
    signals: f.signals.map((s) => ({
      signalId: s.signal_id,
      kind: s.kind,
      firstSeenAt: at(s.first_seen_at),
      order: s.order,
    })),
    alerts: f.alerts.map((a) => ({
      alertId: a.alert_id,
      kind: a.kind,
      triggeredAt: at(a.triggered_at),
      order: a.order,
    })),
  };
  const fresh = planFreshness(facts, at(r.now));
  const actual =
    fresh === null
      ? null
      : {
          state: fresh.state,
          reasons: fresh.reasons.map((reason) => ({
            code: reason.code,
            at: reason.at === null ? null : formatInstant(reason.at),
            ...(reason.noteId === undefined ? {} : { note_id: reason.noteId }),
            ...(reason.signalId === undefined ? {} : { signal_id: reason.signalId }),
            ...(reason.alertId === undefined ? {} : { alert_id: reason.alertId }),
            ...(reason.kind === undefined ? {} : { kind: reason.kind }),
            ...(reason.relation === undefined ? {} : { relation: reason.relation }),
            ...(reason.count === undefined ? {} : { count: reason.count }),
          })),
        };
  expect(actual).toEqual(expected);
});
