import { addDays, parseDateTime } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import { strategyTemplate } from "@cashu/domain/investments/strategy";
import { expect, it } from "vitest";
import { createProfile } from "../../core/commands.js";
import { runQuery, watchQuery } from "../../query.js";
import { testUlid } from "../../testing/store.js";
import { addToWatchlist, createInstrument } from "../commands/index.js";
import { strategySnapshot } from "../desktop/sources.js";
import { investor, TODAY } from "../research/testing/fixtures.js";
import { saveTopicThesis } from "../research/topics.js";
import { researchScreenCommands } from "./commands.js";
import { researchScreenQueries } from "./screen.js";

it("projects a held research screen from tracked real-store sources", () => {
  const h = investor();
  try {
    h.v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["investments"] });
    const template = strategyTemplate("passive_etf");
    if (!template) throw new Error("missing synthetic strategy template");
    const source = {
      strategy: {
        changes: { subscribe: () => () => {} },
        current: (read: typeof h.read) =>
          strategySnapshot(read, {
            vault: h.v.store.vault,
            generation: "test-generation",
            revision: "test-revision",
            files: { yaml: template.yaml, md: template.markdown, readError: null },
          }),
      },
      market: {
        changes: { subscribe: () => () => {} },
        current: () => ({ prices: new market.InMemoryPriceCache() }),
        newestRateDate: () => null,
      },
      clock: {
        current: () => ({ now: parseDateTime(`${TODAY}T12:00:00Z`), timeZone: "Europe/Warsaw" }),
      },
    };
    const query = researchScreenQueries(source).screen;
    const value = query.run(h.read, { today: TODAY, lang: "en" });
    expect(value.status).toBe("current");
    expect(value).toMatchObject({ status: "current" });
    const args = { today: TODAY, lang: "en" } as const;
    expect(runQuery(h.v.store, query, args).tables.has("inv_topic_theses")).toBe(true);
    const pushed: (typeof value)[] = [];
    const stop = watchQuery(h.v.store, query, args, {
      onValue: (snapshot) => pushed.push(snapshot),
      onError: (error) => {
        throw error;
      },
    });
    try {
      h.v.value(saveTopicThesis, { segment: "equity_global", thesis: "Synthetic owner topic" });
      expect(pushed.length).toBeGreaterThan(1);
      const latest = pushed.at(-1);
      expect(latest?.status).toBe("current");
      if (latest?.status === "current")
        expect(latest.topics.find((item) => item.key === "equity_global")?.thesis?.thesis).toBe(
          "Synthetic owner topic",
        );
    } finally {
      stop();
    }
  } finally {
    h.v.store.close();
  }
});

it("does not accept a renderer-selected instrument for a candidate", () => {
  const note = testUlid("01JF", 70);
  const input = researchScreenCommands().acceptCandidate.input.safeParse({
    note,
    instrument: testUlid("01JF", 71),
    lang: "en",
  });
  expect(input.success).toBe(true);
  if (input.success) expect(input.data).toEqual({ note, lang: "en" });
});

it("labels tracked held and watched earnings from the same current calendar feed", () => {
  const h = investor();
  try {
    h.v.value(createProfile, { slug: "calendar", name: "Calendar", modules: ["investments"] });
    const watched = h.v.value(createInstrument, {
      name: "Synthetic watched company",
      currency: "USD",
      assetClass: "equity",
      symbol: "WCH",
      isin: null,
      mic: "XNAS",
    }).gid;
    h.v.value(addToWatchlist, { target: { stored: watched } });
    const template = strategyTemplate("passive_etf");
    if (!template) throw new Error("missing synthetic strategy template");
    const day = addDays(TODAY, 3);
    const source = {
      strategy: {
        changes: { subscribe: () => () => {} },
        current: (read: typeof h.read) =>
          strategySnapshot(read, {
            vault: h.v.store.vault,
            generation: "test-generation",
            revision: "test-revision",
            files: { yaml: template.yaml, md: template.markdown, readError: null },
          }),
      },
      market: {
        changes: { subscribe: () => () => {} },
        current: () => ({ prices: new market.InMemoryPriceCache() }),
        newestRateDate: () => null,
      },
      clock: {
        current: () => ({ now: parseDateTime(`${TODAY}T12:00:00Z`), timeZone: "Europe/Warsaw" }),
      },
      calendar: {
        changes: { subscribe: () => () => {} },
        current: () => ({
          status: "current" as const,
          value: {
            vault: h.v.store.vault,
            generation: "test-generation",
            revision: "calendar-one",
            value: {
              fetched_at: `${TODAY}T06:00:00Z`,
              from: TODAY,
              to: addDays(TODAY, 14),
              macro: [],
              earnings: [
                { date: day, symbol: "XMPL", name: "Held report", when: null },
                { date: day, symbol: "WCH", name: "Watched report", when: null },
              ],
              errors: [],
            },
          },
        }),
      },
    };
    const result = researchScreenQueries(source).screen.run(h.read, { today: TODAY, lang: "en" });
    expect(result.status).toBe("current");
    if (result.status !== "current") return;
    expect(result.calendar.status).toBe("current");
    if (result.calendar.status !== "current") return;
    expect(result.calendar.value.events.filter((event) => event.kind === "earnings")).toEqual([
      expect.objectContaining({ instrument_id: h.xmpl, held: true }),
      expect.objectContaining({ instrument_id: watched, held: false }),
    ]);
  } finally {
    h.v.store.close();
  }
});
