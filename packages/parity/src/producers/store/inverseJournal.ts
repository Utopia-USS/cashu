/**
 * TRANSITIONAL(S25): inverse mode (see `inverse.ts`) of the investments owner and agent state that
 * has no materializer yet: strategy versions, theses, topic theses, alerts, planned deposits, rule
 * runs, research runs and notes. Each builder follows the table's fold in events.md 8.7-8.9.
 */

import type { OutValue } from "../output.ts";
import { json } from "./canonical.ts";
import type { GenesisEvent } from "./genesisRun.ts";
import {
  fields,
  first,
  type InverseSpec,
  last,
  lastOf,
  maybeTime,
  perGid,
  stamp,
  time,
} from "./inverse.ts";

const firstOf = (events: readonly GenesisEvent[]) => events[0] as GenesisEvent;

/**
 * `strategy.versionSaved` in log order; a version whose sha256 equals the current version's is a
 * no-op (m9); `version` is DERIVED: 1, 2, ... over the applied versions.
 */
const strategyVersions: InverseSpec = {
  types: ["strategy.versionSaved"],
  rows: (groups, keys) => {
    const out = [];
    let current: unknown;
    for (const events of groups) {
      const e = first("inv_strategy_versions", events, "strategy.versionSaved");
      if (e.data.sha256 === current) continue;
      current = e.data.sha256;
      const f = fields(e, keys);
      out.push({
        gid: e.gid,
        row: {
          version: BigInt(out.length + 1),
          sha256: f.text("sha256"),
          yaml_text: f.text("yamlText"),
          md_text: f.text("mdText"),
          state: f.text("state"),
          issues: f.json("issues"),
          created_at: time(e, "created_at"),
        },
      });
    }
    return out;
  },
};

/** `thesis.created`; the derived change stamps are seeded by genesis (events.md 8.8, spec 4.4). */
const theses: InverseSpec = {
  types: ["thesis.created"],
  rows: perGid((events, keys) => {
    const e = first("inv_theses", events, "thesis.created");
    const f = fields(e, keys);
    return {
      instrument_id: f.ref("inv_instruments", "instrument"),
      entry_type: f.text("entryType"),
      thesis: f.text("thesis"),
      invalidation: f.text("invalidation"),
      exit_plan: f.text("exitPlan"),
      size_plan: f.text("sizePlan"),
      reviewed_at: stamp(e, "reviewed_at"),
      created_at: time(e, "created_at"),
      updated_at: time(e, "updated_at"),
      core_changed_at: time(e, "core_changed_at"),
      exit_plan_changed_at: stamp(e, "exit_plan_changed_at"),
    };
  }),
};

/**
 * Topic theses (events.md 8.9): the first text event creates the row (`created_by` = its writer,
 * `draft` = written by the agent), `ownerSaved` clears `draft`, texts are LWW, the market view and
 * `rejected_at` come from their own events.
 */
const topicTheses: InverseSpec = {
  types: [
    "topicThesis.draftProposed",
    "topicThesis.ownerSaved",
    "topicThesis.marketViewSet",
    "topicThesis.rejected",
  ],
  rows: perGid((events, keys) => {
    const texts = events.filter(
      (e) => e.type === "topicThesis.draftProposed" || e.type === "topicThesis.ownerSaved",
    );
    const created = texts[0];
    const latest = texts.at(-1);
    if (created === undefined || latest === undefined) return undefined;
    const view = lastOf(events, "topicThesis.marketViewSet");
    const rejected = lastOf(events, "topicThesis.rejected");
    const f = fields(latest, keys);
    const v = view === undefined ? undefined : fields(view, keys);
    return {
      segment: f.text("segment"),
      thesis: f.text("thesis"),
      invalidation: f.text("invalidation"),
      draft: !texts.some((e) => e.type === "topicThesis.ownerSaved"),
      created_by: created.type === "topicThesis.draftProposed" ? "agent" : "owner",
      core_changed_at: time(latest, "core_changed_at"),
      created_at: time(created, "created_at"),
      updated_at: time(last(events), "updated_at"),
      rejected_at: rejected === undefined ? null : time(rejected, "rejected_at"),
      assessment: v?.text("assessment") ?? null,
      outlook: v?.text("outlook") ?? null,
      view_updated_at: view === undefined ? null : time(view, "view_updated_at"),
      view_sources: v === undefined ? null : v.json("sources"),
    };
  }),
};

/**
 * Alerts (events.md 8.7): config from `created`, the owner snooze from `statusSet`, the runtime
 * state from the latest `evaluated`, `deleted_at` from `deleted`. Effective `status` is DERIVED and
 * not compared (S25).
 */
const alerts: InverseSpec = {
  types: ["alert.created", "alert.statusSet", "alert.evaluated", "alert.deleted"],
  rows: perGid((events, keys) => {
    const c = first("alerts", events, "alert.created");
    const f = fields(c, keys);
    const status = lastOf(events, "alert.statusSet");
    const evaluated = lastOf(events, "alert.evaluated");
    const deleted = lastOf(events, "alert.deleted");
    const ev = evaluated?.data ?? {};
    return {
      instrument_id: f.ref("inv_instruments", "instrument"),
      scope: f.text("scope"),
      kind: f.text("kind"),
      params: f.json("params"),
      polarity: f.text("polarity"),
      severity: f.text("severity"),
      title: f.text("title"),
      note: f.text("note"),
      source: f.text("source"),
      created_by: f.text("createdBy"),
      cooldown_days: f.int("cooldownDays"),
      expires_at: maybeTime(c, "expires_at", c.data.expiresAt),
      snoozed_until:
        status?.data.status === "snoozed"
          ? maybeTime(status, "snoozed_until", status.data.snoozedUntil)
          : null,
      last_triggered_at:
        evaluated === undefined
          ? null
          : maybeTime(evaluated, "last_triggered_at", ev.lastTriggeredAt),
      last_checked_at:
        evaluated === undefined ? null : maybeTime(evaluated, "last_checked_at", ev.lastCheckedAt),
      last_value: evaluated === undefined ? null : fields(evaluated, keys).text("lastValue"),
      created_at: time(c, "created_at"),
      updated_at: time(last(events), "updated_at"),
      deleted_at: deleted === undefined ? null : time(deleted, "deleted_at"),
    };
  }),
};

/** Planned deposits (events.md 8.8): `booked` / `cancelled` are terminal (FWW). */
const plannedDeposits: InverseSpec = {
  types: ["plannedDeposit.created", "plannedDeposit.booked", "plannedDeposit.cancelled"],
  rows: perGid((events, keys) => {
    const c = first("inv_planned_deposits", events, "plannedDeposit.created");
    const f = fields(c, keys);
    const terminal = events.find(
      (e) => e.type === "plannedDeposit.booked" || e.type === "plannedDeposit.cancelled",
    );
    const booked = terminal?.type === "plannedDeposit.booked" ? terminal : undefined;
    return {
      account_id: f.ref("accounts", "account"),
      amount: f.text("amount"),
      currency: f.text("currency"),
      planned_date: f.text("plannedDate"),
      note: f.text("note"),
      status: terminal === undefined ? "planned" : booked === undefined ? "cancelled" : "booked",
      booked_txn_id:
        booked === undefined ? null : fields(booked, keys).ref("inv_transactions", "txn"),
      booked_at: booked === undefined ? null : time(booked, "booked_at"),
      created_at: time(c, "created_at"),
      updated_at: time(last(events), "updated_at"),
    };
  }),
};

const ruleRuns: InverseSpec = {
  types: ["ruleRun.finished"],
  rows: perGid((events, keys) => {
    const e = first("inv_rule_runs", events, "ruleRun.finished");
    const f = fields(e, keys);
    return {
      trigger: f.text("trigger"),
      as_of: f.text("asOf"),
      status: f.text("status"),
      strategy_version_id: f.ref("inv_strategy_versions", "strategyVersion"),
      stats: f.json("stats"),
      errors: f.json("errors"),
      report: f.json("report"),
      started_at: time(e, "started_at", e.data.startedAt),
      finished_at: maybeTime(e, "finished_at", e.data.finishedAt),
    };
  }),
};

/** A run stays `running` until `finished`; Python's `counts` default is `{}`. */
const researchRuns: InverseSpec = {
  types: ["researchRun.started", "researchRun.finished"],
  rows: perGid((events, keys) => {
    const s = first("research_runs", events, "researchRun.started");
    const done = lastOf(events, "researchRun.finished");
    const f = fields(s, keys);
    const counts: OutValue = done === undefined ? {} : json(done.data.counts, keys.mapString);
    return {
      started_at: time(s, "started_at"),
      finished_at: done === undefined ? null : time(done, "finished_at"),
      status: done === undefined ? "running" : fields(done, keys).text("status"),
      scope: f.json("scope"),
      counts,
      created_by: f.text("createdBy"),
    };
  }),
};

/**
 * Notes (events.md 8.9): `added` carries the row (owner notes are born read: its stamped `read_at`),
 * `read` sets `read_at`, `dismissed` sets `dismissed_at` and `cooldown_until`.
 */
const researchNotes: InverseSpec = {
  types: ["note.added", "note.read", "note.dismissed"],
  rows: perGid((events, keys) => {
    const a = first("research_notes", events, "note.added");
    const f = fields(a, keys);
    const read = lastOf(events, "note.read");
    const dismissed = lastOf(events, "note.dismissed");
    return {
      run_id: f.ref("research_runs", "run"),
      instrument_id: f.ref("inv_instruments", "instrument"),
      theme: f.text("theme"),
      kind: f.text("kind"),
      polarity: f.text("polarity"),
      strength: f.int("strength"),
      thesis_relation: f.text("thesisRelation"),
      thesis_field: f.text("thesisField"),
      title: f.text("title"),
      summary: f.text("summary"),
      sources: f.json("sources"),
      details: f.json("details"),
      candidate_key: f.text("candidateKey"),
      signal_id: f.ref("inv_signals", "signal"),
      observed_at: time(a, "observed_at", a.data.observedAt),
      expires_at: maybeTime(a, "expires_at", a.data.expiresAt),
      created_by: f.text("createdBy"),
      dismissed_at: dismissed === undefined ? null : time(dismissed, "dismissed_at"),
      cooldown_until:
        dismissed === undefined
          ? null
          : maybeTime(dismissed, "cooldown_until", dismissed.data.cooldownUntil),
      created_at: time(firstOf(events), "created_at"),
      updated_at: time(last(events), "updated_at"),
      read_at: read === undefined ? stamp(a, "read_at") : time(read, "read_at"),
      segment: f.text("segment"),
    };
  }),
};

/** Inverse builders of the journal, signals and research tables. */
export const JOURNAL_INVERSE: Readonly<Record<string, InverseSpec>> = {
  inv_strategy_versions: strategyVersions,
  inv_theses: theses,
  inv_topic_theses: topicTheses,
  alerts,
  inv_planned_deposits: plannedDeposits,
  inv_rule_runs: ruleRuns,
  research_runs: researchRuns,
  research_notes: researchNotes,
};
