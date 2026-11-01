// Test-for-test translation of `tests/investments/persistence/test_rs_service.py`: runs (conflict,
// stale -> failed, counts), note rules (scope, thesis relation, owner-named refusal, duplicates,
// theme spelling), research signals (action / info, notification policy, one signal per instrument
// and week, escalation, polarity), dismiss / restore, housekeeping on expiry, candidates (new
// instruments only, cooldown, accept -> watchlist + draft thesis, undo), the review-digest block and
// the summary. Python errors map to refusal codes (`RESEARCH_REFUSALS`), notifications to the
// command's `notified`. Synthetic data only. Each `it` names its Python test.
//
// Not translated: `test_the_daily_check_keeps_research_signals_open` (the daily check is S22c and
// the rule reconciliation S15b: their reconcile must leave `research:` keys alone).
import { research } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { createInstrument, setManualValuation } from "../commands/instruments.js";
import { createThesis } from "../commands/journal.js";
import { stock } from "../commands/testing/fixtures.js";
import { watchedItemFor } from "../queries/alerts.js";
import { theses } from "../queries/journal.js";
import { acceptCandidate, undoAcceptCandidate } from "./candidates.js";
import {
  dismissResearchNote,
  finishResearchRun,
  researchHousekeeping,
  restoreResearchNote,
  startResearchRun,
} from "./commands.js";
import { noteByGid, runByGid } from "./queries.js";
import { eventInstant } from "./rows.js";
import {
  added,
  addNote,
  DAY,
  distinctWords,
  HOUR,
  investor,
  MINUTE,
  refusal,
  researchSignals,
  thesis,
  watch,
} from "./testing/fixtures.js";
import { researchDigest, researchSummary, runView } from "./views.js";

const now = (i: ReturnType<typeof investor>) =>
  eventInstant(new Date(i.v.env.clock.now()).toISOString());

describe("runs", () => {
  it("test_run_lifecycle", () => {
    const i = investor();
    const { v } = i;
    const run = v.value(startResearchRun, { scope: { themes: ["Banki"], scheduled: true } }).run;
    const row = runByGid(i.read, run);
    expect(row?.status).toBe("running");
    expect(new Set(row?.scope.covered_instrument_ids as string[])).toEqual(
      new Set([i.abc, i.wrld, i.xmpl]),
    );
    expect(row?.scope.scheduled).toBe(true);
    expect(refusal(v.run(startResearchRun, {}))).toBe("run_running");
    const note = added(v, 1).note; // no run: joins the running run
    expect(noteByGid(i.read, note)?.run).toBe(run);
    v.value(finishResearchRun, { run, counts: { sources_checked: 7 } });
    const done = runByGid(i.read, run);
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.counts.notes).toBe(1);
    expect(done?.counts.by_kind).toEqual({ news: 1 });
    expect(done?.counts.sources_checked).toBe(7);
    expect(refusal(v.run(finishResearchRun, { run }))).toBe("run_not_running");
    expect(refusal(v.run(finishResearchRun, { run: "01JZZZZZZZZZZZZZZZZZZZZZZZ" }))).toBe("no_run");
    expect(refusal(addNote(v, 2, {}, { run }))).toBe("run_not_running"); // the run is done
  });

  it("test_stale_run_is_marked_failed", () => {
    const i = investor();
    const { v } = i;
    const run = v.value(startResearchRun, {}).run;
    v.env.advance(5 * HOUR);
    expect(runView(i.read, runByGid(i.read, run), now(i))?.status).toBe("failed"); // at once
    const fresh = v.value(startResearchRun, {}).run;
    const row = runByGid(i.read, run);
    expect(row?.status).toBe("failed");
    expect(row?.counts.reason).toBe("interrupted");
    expect(runView(i.read, row, now(i))?.interrupted).toBe(true);
    expect(runByGid(i.read, fresh)?.status).toBe("running");
    expect(refusal(v.run(finishResearchRun, { run }))).toBe("run_not_running");
  });

  it("test_finish_failed_with_reason_and_bad_counts", () => {
    const i = investor();
    const { v } = i;
    const run = v.value(startResearchRun, {}).run;
    expect(refusal(v.run(finishResearchRun, { run, counts: { notes: 3 } }))).toBe("invalid_counts");
    expect(refusal(v.run(finishResearchRun, { run, status: "cancelled" }))).toBe("invalid_status");
    v.value(finishResearchRun, { run, status: "failed", reason: "limit sesji" });
    const row = runByGid(i.read, run);
    expect(row?.status).toBe("failed");
    expect(row?.counts.reason).toBe("limit sesji");
  });
});

describe("note rules", () => {
  it("test_note_scope_and_thesis_rules", () => {
    const i = investor();
    const { v } = i;
    expect(refusal(addNote(v, 1, {}, { instrument: null }))).toBe("no_scope");
    expect(refusal(addNote(v, 1, { thesis_relation: "weakens" }))).toBe(
      "instrument_without_thesis",
    );
    expect(
      refusal(addNote(v, 1, { theme: "Banki", thesis_relation: "neutral" }, { instrument: null })),
    ).toBe("relation_needs_thesis");
    thesis(v, i.xmpl);
    const weak = added(v, 1, { thesis_relation: "weakens", thesis_field: "invalidation" });
    expect(weak.signal).toBeNull(); // weakens with strength 2: no signal
    expect(refusal(addNote(v, 2, {}, { instrument: "NOPE" }))).toBe("no_instrument");
    const byIsin = added(v, 3, {}, { instrument: "PLABC0000016" }).note;
    expect(noteByGid(i.read, byIsin)?.instrument).toBe(i.abc);
    const first = added(v, 4, { theme: "Półprzewodniki" }, { instrument: null }).note;
    const second = added(v, 5, { theme: "  polprzewodniki " }, { instrument: null }).note;
    expect(noteByGid(i.read, second)?.theme).toBe("Półprzewodniki"); // first spelling kept
    expect(noteByGid(i.read, first)?.expiresAt).toBeTypeOf("bigint");
  });

  it("test_duplicates_are_refused", () => {
    const i = investor();
    const { v } = i;
    added(v, 1);
    expect(refusal(addNote(v, 2, { title: `Example fact number 1 ${distinctWords(1)}` }))).toBe(
      "duplicate",
    );
    expect(refusal(addNote(v, 1, { title: "Another title" }))).toBe("duplicate"); // same source
    added(v, 1, {}, { instrument: "ABC" }); // another scope: fine
    const themeNote = added(v, 7, { theme: "Banki" }, { instrument: null }).note;
    v.value(dismissResearchNote, { note: themeNote });
    expect(
      refusal(
        addNote(
          v,
          8,
          { theme: "banki", title: `Example fact number 7 ${distinctWords(7)}` },
          { instrument: null },
        ),
      ),
    ).toBe("duplicate_dismissed");
  });

  it("test_owner_named_instruments_are_never_researched", () => {
    const i = investor();
    const { v } = i;
    const claim = v.value(createInstrument, {
      name: "Pozyczka Jan Przykladowy",
      symbol: "PRYWATNA",
      currency: "PLN",
      assetClass: "claim",
      valuationMode: "manual",
    }).gid;
    v.value(setManualValuation, {
      instrument: claim,
      asOf: "2026-01-01",
      unitValue: "1",
      currency: "PLN",
    });
    expect(refusal(addNote(v, 1, {}, { instrument: "PRYWATNA" }))).toBe("not_researchable");
  });
});

describe("signals", () => {
  it("test_signal_carries_the_notes_plain_headline", () => {
    const i = investor();
    thesis(i.v, i.xmpl);
    added(i.v, 1, {
      polarity: "negative",
      thesis_relation: "invalidates",
      details: { headline: "Firma płaci za przejęcie nowymi akcjami" },
    });
    const [sig] = researchSignals(i.v);
    expect(sig?.payload.headline).toBe("Firma płaci za przejęcie nowymi akcjami");
  });

  it("test_signal_without_a_headline_keeps_the_title_only", () => {
    const i = investor();
    thesis(i.v, i.xmpl);
    added(i.v, 1, { polarity: "negative", thesis_relation: "invalidates" });
    const [sig] = researchSignals(i.v);
    expect(sig?.payload.headline).toBeNull();
    expect(sig?.payload.title).toBeTruthy();
  });

  it("test_invalidating_note_is_an_action_signal_with_a_notification", () => {
    const i = investor();
    thesis(i.v, i.xmpl);
    const out = added(i.v, 1, { polarity: "negative", thesis_relation: "invalidates" });
    expect(out.signal?.created).toBe(true);
    const sigs = researchSignals(i.v);
    expect(sigs).toHaveLength(1);
    const sig = sigs[0];
    expect(sig).toMatchObject({ severity: "action", polarity: "negative", status: "active" });
    expect(sig?.ruleId).toBe("research:news");
    expect(sig?.kind).toBe("research:news");
    expect(sig?.instrument).toBe(i.xmpl);
    expect(sig?.dedupKey.startsWith("research:")).toBe(true);
    expect(sig?.dedupKey.endsWith(`|i:${i.xmpl}`)).toBe(true);
    expect(sig?.payload.note_id).toBe(out.note);
    expect(sig?.payload.relation).toBe("invalidates");
    expect(out.signal?.notified).toBe(true); // the default policy notifies action
    expect(noteByGid(i.read, out.note)?.signal).toBe(sig?.gid);
  });

  it("test_strength_three_is_info_and_later_notes_join_the_weekly_signal", () => {
    const i = investor();
    const { v } = i;
    thesis(v, i.xmpl);
    const first = added(v, 1, { polarity: "positive", strength: 3 });
    let [sig] = researchSignals(v);
    expect(sig).toMatchObject({ severity: "info", polarity: "positive" });
    expect(first.signal?.notified).toBe(false); // info is not in the default immediate policy
    added(v, 2, { strength: 1 }); // does not qualify: nothing changes
    const second = added(v, 3, {
      polarity: "negative",
      strength: 2,
      thesis_relation: "invalidates",
    });
    expect(second.signal?.escalated).toBe(true);
    expect(second.signal?.created).toBe(false);
    const all = researchSignals(v);
    expect(all).toHaveLength(1); // still one signal for XMPL this week
    [sig] = all;
    expect(sig).toMatchObject({ severity: "action", polarity: "negative" });
    expect(sig?.payload.note_id).toBe(second.note);
    expect(new Set(sig?.payload.note_ids as string[])).toEqual(new Set([first.note, second.note]));
    expect(second.signal?.notified).toBe(true);
    added(v, 4, { theme: "Banki", strength: 3 }, { instrument: null });
    expect(researchSignals(v)).toHaveLength(2); // a theme has its own signal
    const candidate = added(
      v,
      5,
      {
        kind: "candidate",
        strength: 3,
        candidate: { symbol_or_isin: "NEWCO.WA", name: "Newco" },
        details: { entry_type: "trend", criteria: [{ text: "C/Z 9", met: true }] },
      },
      { instrument: null },
    );
    expect(candidate.signal).toBeNull();
    expect(researchSignals(v)).toHaveLength(2); // candidates never become signals
  });

  it("test_dismiss_resolves_and_restore_reopens_the_signal", () => {
    const i = investor();
    const { v } = i;
    thesis(v, i.xmpl);
    const note = added(v, 1, { thesis_relation: "invalidates" }).note;
    const [opened] = researchSignals(v);
    v.value(dismissResearchNote, { note });
    let [sig] = researchSignals(v);
    expect(sig?.status).toBe("resolved");
    expect(sig?.payload.closed_reason).toBe(research.CLOSED_DISMISSED);
    v.env.advance(5 * MINUTE);
    const restored = v.value(restoreResearchNote, { note });
    [sig] = researchSignals(v);
    expect(sig?.gid).toBe(opened?.gid);
    expect(sig?.status).toBe("active");
    expect(sig?.closedAt).toBeNull();
    expect("closed_reason" in (sig?.payload ?? {})).toBe(false);
    expect(restored.signal.notified).toBe(false); // no second notification
    v.env.advance(MINUTE);
    v.value(dismissResearchNote, { note });
    v.env.advance(16 * MINUTE);
    expect(refusal(v.run(restoreResearchNote, { note }))).toBe("undo_expired");
    expect(noteByGid(i.read, note)?.dismissedAt).not.toBeNull();
  });

  it("test_dismissing_one_of_two_notes_keeps_the_signal_open", () => {
    const i = investor();
    const { v } = i;
    thesis(v, i.xmpl);
    const weak = added(v, 1, { strength: 3, polarity: "positive" }).note;
    const strong = added(v, 2, { thesis_relation: "invalidates" }).note;
    v.value(dismissResearchNote, { note: strong });
    const [sig] = researchSignals(v);
    expect(sig?.status).toBe("active");
    expect(sig?.payload.note_id).toBe(weak);
    expect(sig?.polarity).toBe("positive");
  });

  it("test_housekeeping_resolves_signals_of_expired_notes", () => {
    const i = investor();
    const { v } = i;
    added(v, 1, { strength: 3, expires_in_days: 1 });
    expect(researchSignals(v)).toHaveLength(1);
    v.env.advance(2 * DAY);
    expect(v.value(researchHousekeeping, {}).research_signals_resolved).toBe(1);
    const [sig] = researchSignals(v);
    expect(sig?.status).toBe("resolved");
    expect(sig?.payload.closed_reason).toBe(research.CLOSED_EXPIRED);
    expect(v.value(researchHousekeeping, {}).research_signals_resolved).toBe(0);
  });

  it("refuses the housekeeping off the lease (notes_expired is a leader close)", () => {
    const i = investor();
    i.v.env.holder = false;
    expect(refusal(i.v.run(researchHousekeeping, {}))).toBe("not_leader");
  });
});

const CANDIDATE = {
  kind: "candidate",
  polarity: "positive",
  candidate: { symbol_or_isin: "NEWCO.WA", name: "Newco SA" },
  details: {
    entry_type: "sentiment_correction",
    criteria: [{ text: "C/Z 9,8", met: true, threshold: "max 15" }],
  },
};

describe("candidates", () => {
  it("test_candidate_rules_and_cooldown", () => {
    const i = investor();
    const { v } = i;
    const { candidate: _c, ...withoutCandidate } = CANDIDATE;
    expect(refusal(addNote(v, 1, withoutCandidate, { instrument: "ABC" }))).toBe("candidate_held");
    expect(
      refusal(
        addNote(
          v,
          1,
          { ...CANDIDATE, candidate: { symbol_or_isin: "XMPL" } },
          { instrument: null },
        ),
      ),
    ).toBe("candidate_held");
    const note = added(v, 1, CANDIDATE, { instrument: null }).note;
    expect(refusal(addNote(v, 2, CANDIDATE, { instrument: null }))).toBe("candidate_proposed");
    v.value(dismissResearchNote, { note });
    const row = noteByGid(i.read, note);
    expect(row?.cooldownUntil).not.toBeNull();
    expect(
      ((row?.cooldownUntil as bigint) - (row?.dismissedAt as bigint)) / research.MICROS_PER_DAY,
    ).toBe(90n);
    expect(refusal(addNote(v, 3, CANDIDATE, { instrument: null }))).toBe("candidate_cooldown");
    v.value(restoreResearchNote, { note });
    expect(noteByGid(i.read, note)?.cooldownUntil).toBeNull();
  });

  it("test_accept_candidate_and_undo", () => {
    const i = investor();
    const { v } = i;
    const note = added(v, 1, CANDIDATE, { instrument: null }).note;
    // The caller resolves the candidate's symbol first (network before write, S22b's resolver).
    const newco = stock(v, "NEWCO", "PLNEWCO00019", { name: "Newco SA" });
    expect(refusal(v.run(acceptCandidate, { note }))).toBe("unresolved_instrument");
    const result = v.value(acceptCandidate, { note, instrument: newco });
    const item = watchedItemFor(i.read, newco);
    expect(item?.gid).toBe(result.watchlistItem);
    expect(item?.source).toBe("user");
    expect(item?.note?.startsWith("kandydat: ")).toBe(true);
    const own = theses(i.read, newco);
    expect(own[0]?.entryType).toBe("sentiment_correction");
    expect(own[0]?.reviewedAt).toBeNull();
    let row = noteByGid(i.read, note);
    expect(row?.instrument).toBe(newco);
    expect(row?.details?.accepted_at).toBeTruthy();
    expect(refusal(v.run(acceptCandidate, { note, instrument: newco }))).toBe("candidate_accepted");
    v.value(undoAcceptCandidate, { note });
    // F12: the row is soft-removed (never deleted), the draft thesis goes away
    expect(watchedItemFor(i.read, newco)).toBeUndefined();
    expect(theses(i.read, newco)).toEqual([]);
    row = noteByGid(i.read, note);
    expect(row?.instrument).toBeNull();
    expect("accepted_at" in (row?.details ?? {})).toBe(false);
    const again = v.value(acceptCandidate, { note, instrument: newco });
    expect(again.watchlistItem).toBe(result.watchlistItem); // the same row came back
    v.env.advance(20 * MINUTE);
    expect(refusal(v.run(undoAcceptCandidate, { note }))).toBe("undo_expired");
    expect(again.thesis).not.toBeNull();
    const news = added(v, 9).note;
    expect(refusal(v.run(acceptCandidate, { note: news }))).toBe("not_candidate");
  });

  it("test_accept_keeps_an_existing_watch_and_thesis", () => {
    const i = investor();
    const { v } = i;
    const note = added(v, 1, CANDIDATE, { instrument: null }).note;
    const newco = stock(v, "NEWCO", "PLNEWCO00019", { name: "Newco SA" });
    watch(v, newco, "moja obserwacja");
    const own = v.value(createThesis, {
      instrument: newco,
      entryType: "trend",
      thesis: "Moja teza",
    });
    const itemGid = watchedItemFor(i.read, newco)?.gid;
    const result = v.value(acceptCandidate, { note, instrument: newco });
    expect(result.watchlistItem).toBe(itemGid);
    expect(result.thesis).toBe(own.thesis);
    expect(result.createdThesis).toBe(false);
    v.value(undoAcceptCandidate, { note });
    expect(watchedItemFor(i.read, newco)?.note).toBe("moja obserwacja"); // the owner's watch stays
    expect(theses(i.read)[0]?.thesis).toBe("Moja teza");
  });
});

describe("summary and digest", () => {
  it("test_summary_health_and_sentiment_without_themes", () => {
    const i = investor();
    const { v } = i;
    thesis(v, i.xmpl);
    thesis(v, i.abc);
    added(v, 1, {
      thesis_relation: "invalidates",
      thesis_field: "invalidation",
      theme: "Technologia",
    });
    added(v, 2, { polarity: "positive", thesis_relation: "supports" }, { instrument: "ABC" });
    added(v, 3, { theme: "technologia", kind: "community", strength: 3 }, { instrument: null });
    const result = researchSummary(i.read, { now: now(i), lang: "pl", weights: new Map() });
    const rows = new Map(result.instruments.map((r) => [r.label, r]));
    expect(result.instruments[0]?.label).toBe("XMPL"); // invalidated first
    expect(rows.get("XMPL")?.health).toBe("invalidated");
    expect(rows.get("XMPL")?.counts.invalidates).toBe(1);
    expect(rows.get("XMPL")?.fields).toEqual([
      { field: "invalidation", supports: 0, weakens: 0, invalidates: 1, fulfills: 0, neutral: 0 },
    ]);
    expect(rows.get("XMPL")?.sentiment_8w.at(-1)).toBe(Math.round((-2 / 3) * 1e4) / 1e4);
    expect(rows.get("ABC")?.health).toBe("supported");
    expect(rows.get("ABC")?.latest_polarity).toBe("positive");
    expect(rows.get("XMPL")?.last_researched_at).not.toBeNull();
    expect("themes" in result).toBe(false); // P5: segments have their own view
    expect(result.totals.signals_open).toBe(2);
    expect(result.weeks).toHaveLength(8);
  });

  it("test_research_digest_since_the_last_review", () => {
    const i = investor();
    const { v } = i;
    thesis(v, i.xmpl);
    const before = now(i);
    v.env.advance(1000); // the review was a moment before the research
    const run = v.value(startResearchRun, {}).run;
    const note = added(v, 1, { thesis_relation: "invalidates" }, { run }).note;
    added(v, 2, { theme: "Energia", polarity: "positive", strength: 3 }, { instrument: null });
    added(
      v,
      4,
      { theme: "Energia", polarity: "positive", observed_at: "2026-10-23" },
      { instrument: null },
    );
    const cand = added(v, 3, CANDIDATE, { instrument: null }).note;
    const block = researchDigest(i.read, { now: now(i), since: before });
    expect(block.ran_in_period).toBe(true);
    expect(block.run?.id).toBe(run);
    expect(block.notes_count).toBe(4);
    expect(block.signals_count).toBe(2);
    expect(block.counts.invalidates).toBe(1);
    expect(block.by_kind.candidate).toBe(1);
    expect(block.theses_changed).toHaveLength(1);
    const [changed] = block.theses_changed;
    expect(changed).toMatchObject({ label: "XMPL", from: "no_research", to: "invalidated" });
    expect(changed?.note_ids).toEqual([note]);
    expect(block.candidates).toEqual([cand]);
    expect(block.highlights[0]).toBe(note);
    expect("themes_changed" in block).toBe(false);
    expect(Array.isArray(block.segments)).toBe(true);
    const empty = researchDigest(i.read, {
      now: now(i),
      since: now(i) + 60n * research.MICROS_PER_SECOND,
    });
    expect(empty.notes_count).toBe(0);
    expect(empty.ran_in_period).toBe(false);
    expect(empty.theses_unchanged).toBe(1);
  });
});
