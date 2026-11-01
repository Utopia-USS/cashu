// Test-for-test translation of `tests/investments/persistence/test_p9_briefs_service.py`: topic rows'
// briefs, topic theses (save, drafts, delete as a rejection with a cooldown, per vault), the thesis
// relation of topic notes, near duplicates, full refresh runs and the weekly rule of brief notes.
// HTTP calls become the commands / views they serve; status codes become refusal codes. Python
// `ago` (a note stored days back) runs with the vault clock moved back. Synthetic data only. Each
// `it` names its Python test.
//
// Not translated (the macro card view is S22a over S20's macro port; `macroBrief` here is the
// note-side helper it uses): `test_macro_cards_carry_plain_and_the_latest_brief`,
// `test_a_macro_brief_older_than_the_current_state_is_not_shown`, and the card assertion of
// `test_a_brief_with_changed_drivers_replaces_the_shown_one` (its note-side part is below). The
// HTTP-only refusal of an unknown body key (`target`) is the API's (S36).
import { market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { otherVault, type Vault } from "../commands/testing/fixtures.js";
import { PerformanceService } from "../performance/service.js";
import { noBenchmarkStrategy } from "../performance/testing/household.js";
import { dismissResearchNote, finishResearchRun, startResearchRun } from "./commands.js";
import { notes, runByGid, topicCooldowns, topicThesis, topicThesisRow } from "./queries.js";
import { eventInstant } from "./rows.js";
import { segmentsView } from "./segments.js";
import {
  addNote,
  DAY,
  daysAgo,
  distinctWords,
  investor,
  refusal,
  researchSignals,
  TODAY,
} from "./testing/fixtures.js";
import {
  deleteTopicThesis,
  proposeTopicDraft,
  saveTopicThesis,
  topicThesisView,
} from "./topics.js";
import { notesView, runView } from "./views.js";

const TOPIC_BRIEF = {
  headline: "Rośnie popyt na chipy do centrów danych",
  why: "Najwięksi klienci zwiększyli wydatki na serwery z AI.",
};
const MACRO_BRIEF = {
  headline: "Trwa hossa na giełdach",
  why: "Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję.",
  supports: ["Banki centralne obniżają stopy"],
  risks: ["Wyceny są wysoko"],
};

const nowOf = (v: Vault) => eventInstant(new Date(v.env.clock.now()).toISOString());

interface P9Options {
  readonly instrument?: string | null;
  readonly run?: string | null;
  readonly ago?: number;
}

/** Python p9 `add`: an agent note (kind trend, positive), stored `ago` days back. */
function p9(v: Vault, n: number, changes: Record<string, unknown> = {}, o: P9Options = {}) {
  const ago = o.ago ?? 0;
  const body: Record<string, unknown> = {
    kind: "trend",
    polarity: "positive",
    title: `Przykładowy fakt numer ${n} ${distinctWords(n)}`,
    summary: `Przykładowy fakt ${distinctWords(n)} ze źródła, opisany neutralnie.`,
    ...changes,
  };
  return daysAgo(v, ago, (w) => {
    if (ago && !("observed_at" in body)) {
      body.observed_at = new Date(w.env.clock.now()).toISOString().slice(0, 10);
    }
    return addNote(w, n, body, {
      instrument: o.instrument ?? null,
      run: o.run ?? null,
      url: `https://example.com/p9/${n}`,
    });
  });
}

function p9ok(v: Vault, n: number, changes: Record<string, unknown> = {}, o: P9Options = {}) {
  const out = p9(v, n, changes, o);
  if (!out.ok) expect.fail(`note refused: ${out.reason}`);
  return out.value.note;
}

/** Python `brief_note`. */
function briefNote(
  v: Vault,
  n: number,
  segment: string,
  brief: Record<string, unknown>,
  changes: Record<string, unknown> = {},
  o: P9Options = {},
) {
  return p9(v, n, { expires_in_days: 60, segment, details: { brief }, ...changes }, o);
}

function briefOk(...args: Parameters<typeof briefNote>) {
  const out = briefNote(...args);
  if (!out.ok) expect.fail(`brief note refused: ${out.reason}`);
  return out.value.note;
}

function segmentRows(v: Vault) {
  const cache = new market.InMemoryPriceCache();
  const computed = new PerformanceService().computed(v.store, {
    asOf: TODAY,
    strategy: noBenchmarkStrategy(),
    prices: cache,
  });
  const out = segmentsView(v.store.read.bind(v.store), {
    computed,
    prices: cache,
    now: nowOf(v),
    lang: "pl",
  });
  if (!out.ok) expect.fail(out.reason);
  return new Map(out.value.segments.map((r) => [r.segment, r]));
}

const thesisOf = (v: Vault, segment: string) =>
  topicThesisView(topicThesis(v.store.read.bind(v.store), segment), "pl");

describe("topic briefs and theses", () => {
  it("test_topic_rows_carry_up_to_three_active_briefs_newest_first", () => {
    const { v } = investor();
    const headlines = [
      "Rośnie popyt na chipy",
      "Producenci chipów budują fabryki",
      "Ceny pamięci w górę",
      "Rynek w konsolidacji",
    ];
    const ids = [30, 23, 16, 9].map((ago, k) =>
      briefOk(
        v,
        k + 1,
        "semis_ai",
        { headline: headlines[k], why: `Inny powód ${distinctWords(k + 1)}.` },
        {},
        { ago },
      ),
    );
    p9ok(v, 9, { segment: "semis_ai" }); // newest, but no brief
    const expired = briefOk(
      v,
      10,
      "games_media",
      TOPIC_BRIEF,
      { expires_in_days: 19 },
      { ago: 20 },
    );
    const rows = segmentRows(v);
    const briefs = rows.get("semis_ai")?.briefs as Record<string, unknown>[];
    expect(briefs.map((b) => b.note_id)).toEqual([...ids].reverse().slice(0, 3));
    expect(new Set(Object.keys(briefs[0] ?? {}))).toEqual(
      new Set(["note_id", "headline", "why", "observed_at", "kind", "polarity", "unread"]),
    );
    expect([briefs[0]?.kind, briefs[0]?.polarity, briefs[0]?.unread]).toEqual([
      "trend",
      "positive",
      true,
    ]);
    expect(rows.get("semis_ai")?.thesis).toBeNull();
    expect(expired).toBeTruthy();
    expect(rows.get("games_media")?.briefs ?? []).toEqual([]); // expired
  });

  it("test_topic_thesis_http_crud", () => {
    const { v } = investor();
    expect(thesisOf(v, "games_media")).toBeNull();
    v.value(saveTopicThesis, {
      segment: "games_media",
      thesis: "Ludzie grają coraz więcej.",
      invalidation: "Spadek",
    });
    const body = thesisOf(v, "games_media");
    expect(new Set(Object.keys(body ?? {}))).toEqual(
      new Set([
        "id",
        "segment",
        "label",
        "thesis",
        "invalidation",
        "assessment",
        "outlook",
        "view_updated_at",
        "view_sources",
        "draft",
        "created_by",
        "core_changed_at",
        "created_at",
        "updated_at",
      ]),
    );
    expect([body?.segment, body?.label, body?.draft, body?.created_by]).toEqual([
      "games_media",
      "Gry",
      false,
      "owner",
    ]);
    expect(body?.assessment).toBeNull();
    expect(body?.outlook).toBeNull();
    // the topic shows as a row with its thesis (a thesis alone makes the row)
    const rows = segmentRows(v);
    expect((rows.get("games_media")?.thesis as { thesis: string } | null)?.thesis).toBe(
      "Ludzie grają coraz więcej.",
    );
    v.value(saveTopicThesis, { segment: "games_media", thesis: "Ludzie grają coraz więcej." });
    const cleared = thesisOf(v, "games_media");
    expect(cleared?.invalidation).toBeNull();
    expect(cleared?.id).toBe(body?.id);
    expect(refusal(v.run(saveTopicThesis, { segment: "games_media", thesis: " " }))).toBe(
      "invalid_thesis",
    );
    expect(
      refusal(v.run(saveTopicThesis, { segment: "games_media", thesis: "x".repeat(601) })),
    ).toBe("invalid_thesis");
    expect(refusal(v.run(saveTopicThesis, { segment: "macro_risk", thesis: "x" }))).toBe(
      "macro_segment",
    );
    expect(refusal(v.run(saveTopicThesis, { segment: "Gry", thesis: "x" }))).toBe(
      "invalid_segment",
    );
    expect(v.value(deleteTopicThesis, { segment: "games_media" })).toEqual({ deleted: true });
    expect(v.value(deleteTopicThesis, { segment: "games_media" })).toEqual({ deleted: false });
    expect(thesisOf(v, "games_media")).toBeNull();
  });

  it("test_owner_save_confirms_an_agent_draft", () => {
    const { v, read } = investor();
    const first = v.value(proposeTopicDraft, {
      segment: "semis_ai",
      thesis: "Szkic tezy o chipach.",
    });
    let row = topicThesis(read, "semis_ai");
    expect(first.created).toBe(true);
    expect(row?.draft).toBe(true);
    expect(row?.createdBy).toBe("agent");
    const again = v.value(proposeTopicDraft, {
      segment: "semis_ai",
      thesis: "Szkic tezy o chipach v2.",
      invalidation: "Spadek popytu",
    });
    expect(again.created).toBe(false);
    expect(again.topic).toBe(first.topic);
    expect(topicThesis(read, "semis_ai")?.draft).toBe(true);
    v.value(proposeTopicDraft, { segment: "semis_ai", thesis: "Szkic tezy o chipach v3." });
    expect(topicThesis(read, "semis_ai")?.invalidation).toBe("Spadek popytu"); // kept
    expect(thesisOf(v, "semis_ai")?.draft).toBe(true);
    v.value(saveTopicThesis, {
      segment: "semis_ai",
      thesis: "Szkic tezy o chipach v3.",
      invalidation: "X",
    });
    row = topicThesis(read, "semis_ai");
    expect([row?.draft, row?.createdBy]).toEqual([false, "agent"]);
    expect(
      refusal(v.run(proposeTopicDraft, { segment: "semis_ai", thesis: "Nowa teza agenta." })),
    ).toBe("owner_thesis");
  });

  it("test_topic_theses_are_per_profile", () => {
    const { v } = investor();
    const other = otherVault();
    other.value(saveTopicThesis, { segment: "crypto", thesis: "Teza innego profilu." });
    expect(thesisOf(v, "crypto")).toBeNull();
    expect(v.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_topic_theses")[0]?.n).toBe(0);
    expect(
      other.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_topic_theses")[0]?.n,
    ).toBe(1);
  });

  it("test_deleting_a_draft_is_a_rejection_with_a_cooldown", () => {
    const { v, read } = investor();
    v.value(proposeTopicDraft, { segment: "crypto", thesis: "Szkic tezy o krypto." });
    expect(v.value(deleteTopicThesis, { segment: "crypto" })).toEqual({ deleted: true });
    expect(thesisOf(v, "crypto")).toBeNull();
    expect(v.value(deleteTopicThesis, { segment: "crypto" })).toEqual({ deleted: false });
    expect(segmentRows(v).get("crypto")?.thesis ?? null).toBeNull();
    expect(topicThesisRow(read, "crypto")?.rejectedAt).not.toBeNull();
    expect([...topicCooldowns(read, nowOf(v)).keys()]).toEqual(["crypto"]);
    expect(
      refusal(v.run(proposeTopicDraft, { segment: "crypto", thesis: "Nowy szkic o krypto." })),
    ).toBe("rejected_draft");
    // after the cooldown the agent may propose again
    v.env.advance(91 * DAY);
    const again = v.value(proposeTopicDraft, { segment: "crypto", thesis: "Nowy szkic o krypto." });
    expect(again.created).toBe(true);
    expect(topicThesis(read, "crypto")?.draft).toBe(true);
    expect(topicThesis(read, "crypto")?.rejectedAt).toBeNull();
    v.value(deleteTopicThesis, { segment: "crypto" }); // rejected once more
    v.value(saveTopicThesis, { segment: "crypto", thesis: "Moja teza o krypto." });
    const body = thesisOf(v, "crypto");
    expect([body?.draft, body?.created_by, body?.thesis]).toEqual([
      false,
      "owner",
      "Moja teza o krypto.",
    ]);
    // the owner deleting his own thesis is a rejection too: the same 90-day cooldown
    expect(v.value(deleteTopicThesis, { segment: "crypto" })).toEqual({ deleted: true });
    expect(thesisOf(v, "crypto")).toBeNull();
    expect([...topicCooldowns(read, nowOf(v)).keys()]).toEqual(["crypto"]);
    expect(
      refusal(v.run(proposeTopicDraft, { segment: "crypto", thesis: "Kolejny szkic o krypto." })),
    ).toBe("rejected_draft");
  });

  it("test_deleting_a_confirmed_draft_starts_the_cooldown", () => {
    const { v, read } = investor();
    v.value(proposeTopicDraft, { segment: "gold", thesis: "Szkic o złocie." });
    v.value(saveTopicThesis, { segment: "gold", thesis: "Szkic o złocie." });
    expect(thesisOf(v, "gold")?.draft).toBe(false);
    expect(v.value(deleteTopicThesis, { segment: "gold" })).toEqual({ deleted: true });
    expect([...topicCooldowns(read, nowOf(v)).keys()]).toEqual(["gold"]);
    expect(
      refusal(v.run(proposeTopicDraft, { segment: "gold", thesis: "Nowy szkic o złocie." })),
    ).toBe("rejected_draft");
  });
});

describe("thesis relation on topic notes", () => {
  it("test_a_topic_note_bears_on_the_topic_thesis_only_when_it_exists", () => {
    const { v, read } = investor();
    expect(refusal(p9(v, 1, { segment: "healthcare", thesis_relation: "weakens" }))).toBe(
      "topic_without_thesis",
    );
    v.value(saveTopicThesis, {
      segment: "healthcare",
      thesis: "Ubezpieczyciele zdrowotni zarabiają.",
    });
    const note = p9ok(v, 2, {
      segment: "healthcare",
      kind: "news",
      polarity: "negative",
      thesis_relation: "invalidates",
      title: "Zabójstwo prezesa UnitedHealth wstrząsa branżą",
    });
    const sigs = researchSignals(v);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.severity).toBe("action");
    expect(sigs[0]?.message).toContain("podważa tezę");
    const rows = notesView(read, notes(read, nowOf(v), { segment: "healthcare" }), nowOf(v), "pl");
    expect(rows.map((r) => [r.id, r.thesis_relation, r.thesis_field])).toEqual([
      [note, "invalidates", "thesis"],
    ]);
  });

  it("test_no_thesis_relation_against_a_draft", () => {
    const { v } = investor();
    v.value(proposeTopicDraft, {
      segment: "healthcare",
      thesis: "Szkic tezy o ubezpieczycielach.",
    });
    expect(refusal(p9(v, 1, { segment: "healthcare", thesis_relation: "weakens" }))).toBe(
      "topic_thesis_draft",
    );
    v.value(saveTopicThesis, { segment: "healthcare", thesis: "Szkic tezy o ubezpieczycielach." });
    p9ok(v, 2, { segment: "healthcare", thesis_relation: "weakens" });
  });

  it("test_a_topic_invalidates_note_passes_the_weekly_segment_cap", () => {
    const { v } = investor();
    v.value(saveTopicThesis, {
      segment: "healthcare",
      thesis: "Ubezpieczyciele zdrowotni zarabiają.",
    });
    const run = v.value(startResearchRun, { scope: { scheduled: true } }).run;
    ["gold", "crypto", "bonds", "energy", "metals", "power"].forEach((segment, k) => {
      p9ok(v, k + 1, { segment, kind: "macro" }, { run });
    });
    expect(refusal(p9(v, 10, { segment: "healthcare" }, { run }))).toBe("novelty_segments");
    p9ok(v, 11, { segment: "healthcare", kind: "news", thesis_relation: "invalidates" }, { run });
  });
});

describe("near duplicates", () => {
  it("test_near_duplicates_are_refused_within_the_same_scope", () => {
    const { v } = investor();
    p9ok(
      v,
      1,
      { kind: "news", title: "Nvidia podnosi prognozę przychodów na kwartał" },
      { instrument: "ABC", ago: 20 },
    );
    expect(
      refusal(
        p9(
          v,
          2,
          { kind: "news", title: "Nvidia podniosła prognozę przychodów" },
          { instrument: "ABC" },
        ),
      ),
    ).toBe("near_duplicate");
    // another fact about the same company passes; the same fact on another scope passes
    p9ok(v, 3, { kind: "news", title: "Nvidia ogłasza skup akcji" }, { instrument: "ABC" });
    p9ok(
      v,
      4,
      { kind: "news", title: "Nvidia podniosła prognozę przychodów" },
      { instrument: "XMPL" },
    );
    // a brief headline restated on a topic, next week
    briefOk(v, 5, "semis_ai", TOPIC_BRIEF, {}, { ago: 8 });
    const rephrased = { ...TOPIC_BRIEF, headline: "Popyt na chipy do centrów danych dalej rośnie" };
    expect(refusal(briefNote(v, 6, "semis_ai", rephrased, { title: TOPIC_BRIEF.headline }))).toBe(
      "near_duplicate",
    );
  });

  it("test_dismissed_and_old_notes_are_not_compared", () => {
    const { v } = investor();
    p9ok(
      v,
      1,
      { title: "CD Projekt przesuwa premierę gry", expires_in_days: 90 },
      { instrument: "ABC", ago: 61 },
    );
    p9ok(v, 2, { title: "CD Projekt przesunął premierę gry" }, { instrument: "ABC" }); // > 60 days
    const dismissed = p9ok(
      v,
      3,
      { title: "Fundusz obniża opłatę za zarządzanie" },
      { instrument: "WRLD" },
    );
    v.value(dismissResearchNote, { note: dismissed });
    p9ok(v, 4, { title: "Fundusz obniżył opłatę za zarządzanie" }, { instrument: "WRLD" });
  });
});

describe("full refresh and the brief weekly rule", () => {
  it("test_a_full_refresh_run_skips_the_novelty_caps_only", () => {
    const { v, read } = investor();
    const run = v.value(startResearchRun, { scope: { full_refresh: true } }).run;
    const row = runByGid(read, run);
    expect(row?.scope.held).toBe(true);
    expect(row?.scope.full_refresh).toBe(true);
    const stored = runView(read, row, nowOf(v));
    expect(stored?.full_refresh).toBe(true);
    expect(stored?.scope.full_refresh).toBe(true);
    ["ABC", "WRLD", "XMPL"].forEach((ref, k) => {
      for (const j of [0, 1, 2]) p9ok(v, (k + 1) * 10 + j, {}, { instrument: ref, run }); // over 2
    });
    const segments = ["gold", "crypto", "bonds", "energy", "metals", "power", "healthcare"];
    segments.forEach((segment, k) => {
      p9ok(v, 50 + k, { segment, kind: "macro" }, { run }); // 7 segment notes: over the weekly 6
    });
    expect(refusal(p9(v, 70, { segment: "gold", kind: "macro" }, { run }))).toBe("segment_week");
    const title = `Przykładowy fakt numer 10 ${distinctWords(10)} ponownie`;
    expect(refusal(p9(v, 71, { title }, { instrument: "ABC", run }))).toBe("near_duplicate");
    v.value(finishResearchRun, { run });
    const weekly = v.value(startResearchRun, { scope: { scheduled: true } }).run;
    expect(runByGid(read, weekly)?.scope.full_refresh).toBe(false);
    expect(runView(read, runByGid(read, weekly), nowOf(v))?.full_refresh).toBe(false);
  });

  it("test_brief_notes_have_their_own_weekly_rule", () => {
    const { v } = investor();
    const plain = p9ok(v, 1, { segment: "semis_ai" });
    briefOk(v, 2, "semis_ai", TOPIC_BRIEF);
    expect(
      refusal(
        briefNote(v, 3, "semis_ai", {
          headline: "Producenci chipów budują fabryki",
          why: "Nowe fabryki w Azji i USA.",
        }),
      ),
    ).toBe("segment_week_brief");
    expect(refusal(p9(v, 4, { segment: "semis_ai" }))).toBe("segment_week");
    // dismissing the plain note does not free the plain slot; it never blocked the brief anyway
    v.value(dismissResearchNote, { note: plain });
    expect(refusal(p9(v, 5, { segment: "semis_ai" }))).toBe("segment_week");
  });

  it("test_a_full_refresh_lifts_the_weekly_rule_for_brief_notes_only", () => {
    const { v } = investor();
    briefOk(v, 1, "macro_risk", MACRO_BRIEF, { kind: "macro" });
    p9ok(v, 2, { segment: "macro_risk", kind: "macro" });
    const run = v.value(startResearchRun, { scope: { full_refresh: true } }).run;
    const changed = {
      ...MACRO_BRIEF,
      headline: "Akcje są w korekcie, ale zyski spółek rosną",
      why: "Ceny akcji cofnęły się od szczytu, choć wyniki firm są nadal dobre.",
    };
    briefOk(v, 3, "macro_risk", changed, { kind: "macro", polarity: "neutral" }, { run });
    expect(refusal(p9(v, 4, { segment: "macro_risk", kind: "macro" }, { run }))).toBe(
      "segment_week",
    );
  });

  it("test_a_brief_with_changed_drivers_replaces_the_shown_one (notes part)", () => {
    const { v, read } = investor();
    const old = briefOk(v, 1, "macro_risk", MACRO_BRIEF, { kind: "macro" }, { ago: 10 });
    const fresh = briefOk(
      v,
      2,
      "macro_risk",
      {
        ...MACRO_BRIEF,
        headline: "Hossa na giełdach trwa",
        why: "Banki centralne obniżają koszt kredytu, a rynek pracy pozostaje mocny.",
      },
      { kind: "macro" },
    );
    const rows = notes(read, nowOf(v), { segment: "macro_risk" });
    expect(new Set(rows.map((r) => r.gid))).toEqual(new Set([old, fresh]));
    expect(rows[0]?.gid).toBe(fresh); // newest observation first: the card's brief (S22a)
  });
});
