import { parseDateTime, toStorage } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import { strategyTemplate } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { createProfile, setModules } from "../../core/commands.js";
import { createProposal } from "../../core/proposal-commands.js";
import { pendingProposals } from "../../core/proposal-execution.js";
import { watchQuery } from "../../query.js";
import { createThesis, updateThesis } from "../commands/journal.js";
import { addManualTransaction } from "../commands/manual.js";
import { applyRaw, brokerage, raw, rawGid, stock, vault } from "../commands/testing/fixtures.js";
import { addToWatchlist } from "../commands/watchlist.js";
import { strategySnapshot } from "../desktop/sources.js";
import { signalsOwnerCommands } from "../desktop-signals/commands.js";
import { conditionalOwnerAcknowledge } from "../desktop-signals/conditionalAcknowledge.js";
import { decisions } from "../queries/journal.js";
import { lastReview } from "../queries/reviews.js";
import { viewInstant } from "../research/rows.js";
import { researchDigest } from "../research/views.js";
import { reviewPositionDecision, saveReview, undoSavedReview } from "./commands.js";
import { readReviewDecide } from "./decide.js";
import { reviewScreenQueries } from "./screen.js";

function fixture() {
  const v = vault();
  v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["investments"] });
  const instrument = stock(v, "SYN", "PL0000000101");
  v.value(addToWatchlist, { target: { stored: instrument } });
  const read = v.store.read.bind(v.store);
  return { v, read, instrument };
}
const session = {
  cards: [{ id: "world", verdict: "flag" }],
  agenda: [{ card: "world", note: "Synthetic agenda" }],
  decisions: [],
  skipped: [],
  minutes: 3,
};
describe("native Review owner and tracked projection", () => {
  it("skips members closed or decided after the frozen deck without appending another journal row", () => {
    const { v, read, instrument } = fixture();
    try {
      const a = rawGid(831),
        b = rawGid(832);
      applyRaw(v, [
        raw.signalOpened(a, "closed", { instrument }),
        raw.signalOpened(b, "decided", { instrument }),
      ]);
      applyRaw(v, [
        { type: "signal.closed", gid: a, data: { status: "resolved", reason: "rule_cleared" } },
      ]);
      v.value(signalsOwnerCommands.acknowledge, { signal: b });
      expect(v.value(conditionalOwnerAcknowledge, { signal: a })).toMatchObject({
        decision: null,
        skipped: "closed",
      });
      expect(v.value(conditionalOwnerAcknowledge, { signal: b })).toMatchObject({
        decision: null,
        skipped: "decided",
      });
      expect(decisions(read)).toHaveLength(1);
    } finally {
      v.store.close();
    }
  });
  it("uses the primitive's Unicode character limit rather than a UTF16 code-unit cap", () => {
    const { v, read } = fixture();
    try {
      v.value(saveReview, { notes: "😀".repeat(4000), session });
      expect(lastReview(read, "investments")?.notes).toBe("😀".repeat(4000));
      expect(v.run(saveReview, { notes: "😀".repeat(4001), session })).toMatchObject({
        ok: false,
        reason: "invalid_input",
      });
    } finally {
      v.store.close();
    }
  });
  it("saves fresh authoritative totals separately from frozen session facts and undoes only within the real window", () => {
    const { v, read } = fixture();
    try {
      applyRaw(v, [raw.signalOpened(rawGid(801), "one")]);
      const saved = v.value(saveReview, {
        notes: " Synthetic closing ",
        session: { ...session, open_signals: 999 },
      });
      expect(lastReview(read, "investments")).toMatchObject({
        notes: "Synthetic closing",
        stats: { source: "app", open_signals: 1, decisions_since_last_review: 0, session },
      });
      v.value(undoSavedReview, { review: saved.review });
      expect(lastReview(read, "investments")).toBeUndefined();
      const again = v.value(saveReview, { notes: null, session });
      v.env.advance(15 * 60000 + 1);
      expect(v.run(undoSavedReview, { review: again.review })).toMatchObject({
        ok: false,
        reason: "undo_expired",
      });
      v.value(setModules, { moduleIds: [] });
      expect(v.run(saveReview, { notes: null, session })).toMatchObject({
        ok: false,
        reason: "module_disabled",
      });
    } finally {
      v.store.close();
    }
  });
  it("filters already decided members in the same write context and never creates an empty duplicate position decision", () => {
    const { v, read, instrument } = fixture();
    try {
      const a = rawGid(811),
        b = rawGid(812);
      applyRaw(v, [
        raw.signalOpened(a, "one", { instrument }),
        raw.signalOpened(b, "two", { instrument }),
      ]);
      v.value(signalsOwnerCommands.acknowledge, { signal: a });
      v.value(reviewPositionDecision, { instrument, signals: [a, b], action: "held" });
      expect(decisions(read)).toHaveLength(2);
      expect(
        v.run(reviewPositionDecision, { instrument, signals: [a, b], action: "held" }),
      ).toMatchObject({ ok: false, reason: "no_open_signal" });
      expect(decisions(read)).toHaveLength(2);
    } finally {
      v.store.close();
    }
  });
  it("selects canonical newest-created thesis even after an older historical thesis is edited", () => {
    const { v, read, instrument } = fixture();
    try {
      const older = v.value(createThesis, {
        instrument,
        entryType: "trend",
        thesis: "Older",
        invalidation: "Old invalidation",
      });
      v.env.advance(1000);
      v.value(createThesis, {
        instrument,
        entryType: "trend",
        thesis: "Current",
        invalidation: "Current invalidation",
      });
      v.env.advance(1000);
      v.value(updateThesis, {
        id: older.thesis,
        values: { thesis: "Edited historical thesis", invalidation: "Edited old invalidation" },
      });
      applyRaw(v, [raw.signalOpened(rawGid(821), "one", { instrument, polarity: "negative" })]);
      const now = "2026-10-31T12:01:00Z";
      const result = readReviewDecide(read, {
        now,
        since: "2026-10-24T00:00:00Z",
        account: null,
        research: researchDigest(read, {
          now: viewInstant(toStorage(now)),
          since: viewInstant(toStorage("2026-10-24T00:00:00Z")),
        }),
      });
      expect(result.items[0]).toMatchObject({
        thesis: "Current",
        invalidation: "Current invalidation",
      });
    } finally {
      v.store.close();
    }
  });
  it("projects one carried rail subject from two open signals while preserving the full signal count", () => {
    const { v, read, instrument } = fixture();
    try {
      applyRaw(v, [raw.signalOpened(rawGid(841), "first", { instrument })]);
      v.env.advance(60_000);
      applyRaw(v, [raw.signalOpened(rawGid(842), "second", { instrument })]);
      applyRaw(v, [
        { type: "signal.snoozed", gid: rawGid(841), data: { until: "2026-11-03T12:00:00Z" } },
      ]);
      const now = "2026-11-02T12:01:00Z";
      const lastReviewAt = "2026-11-01T12:00:00Z";
      const result = readReviewDecide(read, {
        now,
        since: lastReviewAt,
        lastReviewAt,
        includeSnoozed: true,
        limit: Number.MAX_SAFE_INTEGER,
        account: null,
        research: researchDigest(read, {
          now: viewInstant(toStorage(now)),
          since: viewInstant(toStorage(lastReviewAt)),
        }),
      });
      expect(result.total).toBe(2);
      expect(result.items.filter((item) => item.kind === "subject")).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        kind: "subject",
        fresh: false,
      });
      expect(new Set(result.items[0]?.signals)).toEqual(new Set([rawGid(841), rawGid(842)]));
      expect(result.items[0]?.seenAt).toBe(Date.parse("2026-10-31T12:01:00Z"));
      expect(result.items[0]?.snoozedUntil).toBeNull();
    } finally {
      v.store.close();
    }
  });
  it("keeps portfolio-wide and watched-only signals under an account filter but excludes holdings elsewhere", () => {
    const { v, read } = fixture();
    try {
      const selected = brokerage(v, "Selected");
      const elsewhere = brokerage(v, "Elsewhere");
      const held = stock(v, "HELD", "PL0000000102");
      const watched = stock(v, "WATCH", "PL0000000103");
      applyRaw(v, [raw.watchAdded(v, held), raw.watchAdded(v, watched)]);
      v.value(addManualTransaction, {
        account: elsewhere,
        type: "deposit",
        tradeDate: "2026-10-30",
        cashAmount: "100",
      });
      v.value(addManualTransaction, {
        account: elsewhere,
        instrument: held,
        type: "buy",
        tradeDate: "2026-10-30",
        quantity: "1",
        price: "10",
      });
      applyRaw(v, [
        raw.signalOpened(rawGid(851), "held", { instrument: held }),
        raw.signalOpened(rawGid(852), "watched", { instrument: watched }),
        raw.signalOpened(rawGid(853), "portfolio"),
      ]);
      const now = "2026-10-31T12:01:00Z";
      const result = readReviewDecide(read, {
        now,
        since: "2026-10-24T00:00:00Z",
        today: "2026-10-31",
        account: selected,
        research: researchDigest(read, { now: viewInstant(toStorage(now)), since: null }),
      });
      expect(result.total).toBe(2);
      expect(result.items.flatMap((item) => item.signals)).not.toContain(rawGid(851));
      expect(result.items.flatMap((item) => item.signals)).toEqual(
        expect.arrayContaining([rawGid(852), rawGid(853)]),
      );
    } finally {
      v.store.close();
    }
  });
  it("keeps all pending investment proposals beyond the six-subject limit and excludes budget proposals", () => {
    const { v, read } = fixture();
    try {
      for (let i = 0; i < 8; i++)
        v.value(createProposal, {
          kind: "custom_rule",
          summary: `Synthetic ${i}`,
          reason: null,
          payload: {},
          source: "synthetic",
        });
      v.value(createProposal, {
        kind: "budget_import",
        summary: "Budget",
        reason: null,
        payload: {},
        source: "synthetic",
      });
      const now = "2026-10-31T12:01:00Z";
      const result = readReviewDecide(read, {
        now,
        since: "2026-10-24T00:00:00Z",
        account: null,
        research: researchDigest(read, { now: viewInstant(toStorage(now)), since: null }),
      });
      expect(pendingProposals(read)).toHaveLength(8);
      expect(result.items.filter((row) => row.kind === "proposal")).toHaveLength(8);
    } finally {
      v.store.close();
    }
  });
  it("invalidates review schedule from actual review events and distinguishes unbound from current empty calendar", () => {
    const { v, read } = fixture();
    try {
      const template = strategyTemplate("passive_etf");
      if (!template) throw new Error("missing actual template");
      const changes = { subscribe: () => () => {} };
      const sources = {
        strategy: {
          changes,
          current: (tracked: typeof read) =>
            strategySnapshot(tracked, {
              vault: v.store.vault,
              generation: "test",
              revision: "one",
              files: { yaml: template.yaml, md: template.markdown, readError: null },
            }),
        },
        market: {
          changes,
          current: () => ({ prices: new market.InMemoryPriceCache() }),
          newestRateDate: () => null,
        },
        clock: {
          current: () => ({
            now: parseDateTime("2026-10-31T12:00:00Z"),
            timeZone: "Europe/Warsaw",
          }),
        },
      };
      const query = reviewScreenQueries(sources).screen,
        args = { today: "2026-10-31", lang: "en" as const, open: true };
      const values: ReturnType<typeof query.run>[] = [];
      const stop = watchQuery(v.store, query, args, {
        onValue: (value) => values.push(value),
        onError: (error) => {
          throw error;
        },
      });
      try {
        expect(values[0]).toMatchObject({
          status: "current",
          last: null,
          calendar: { status: "unavailable" },
        });
        v.value(saveReview, { notes: null, session });
        expect(values.at(-1)).toMatchObject({
          status: "current",
          last: { stats: { source: "app" } },
        });
        const current = reviewScreenQueries({
          ...sources,
          calendar: {
            changes,
            current: () => ({
              status: "current",
              value: {
                vault: v.store.vault,
                generation: "test",
                revision: "one",
                value: market.emptyFeeds("2026-10-31", 14, []),
              },
            }),
          },
        }).screen.run(read, args);
        expect(current).toMatchObject({
          status: "current",
          calendar: { status: "current", value: { events: [], stale: false } },
        });
      } finally {
        stop();
      }
    } finally {
      v.store.close();
    }
  });
});
