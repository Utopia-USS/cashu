/** Generated Electron100 facts only. The coordinator calls this inside an isolated synthetic host. */
import { addDays, D, parseDateTime } from "@cashu/domain";
import { market, toCurrency } from "@cashu/domain/investments";
import {
  investmentsCommands as C,
  type Command,
  type investmentsLocal,
  investmentsResearch as research,
  runCommand,
} from "@cashu/store";
import { brokerageAccounts } from "@cashu/store/investments/queries";
import type { ReviewScreenSources } from "@cashu/store/investments/review-screen";
import type { OpenVault } from "../stores.js";

export function reviewDemoSources(
  vault: string,
  today: string,
): Pick<ReviewScreenSources, "calendar" | "macro"> {
  if (process.env.CASHU_E2E_REVIEW !== "1" || process.env.CASHU_TESTING !== "1")
    throw new Error("synthetic_review_required");
  const changes = { subscribe: () => () => {} };
  const feeds: market.CalendarFeeds = {
    ...market.emptyFeeds(today, 14, []),
    fetched_at: `${today}T08:00:00Z`,
    macro: [
      {
        date: addDays(today, 1),
        time: "14:30",
        country: "US",
        title: "Synthetic calendar release",
        source_title: "Synthetic calendar release",
      },
    ],
  };
  return {
    macro: {
      changes,
      current: (read) =>
        read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid === vault
          ? {
              status: "current",
              value: { vault, generation: "review100", revision: "macro-empty", value: {} },
            }
          : { status: "unavailable", reason: "not_synthetic_review_vault" },
    },
    calendar: {
      changes,
      current: (read) =>
        read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid === vault
          ? {
              status: "current",
              value: { vault, generation: "review100", revision: "calendar-one", value: feeds },
            }
          : { status: "unavailable", reason: "not_synthetic_review_vault" },
    },
  };
}

export function seedReviewDemo(
  vault: OpenVault,
  prices: investmentsLocal.SqlPriceCache,
  today: string,
) {
  if (process.env.CASHU_E2E_REVIEW !== "1" || process.env.CASHU_TESTING !== "1")
    throw new Error("synthetic_review_required");
  const read = vault.store.read.bind(vault.store);
  if (brokerageAccounts(read).some((account) => account.name === "Synthetic Review100")) return;
  const run = <I, R>(command: Command<I, R>, input: unknown): R => {
    const result = runCommand(vault.store, vault.writer, command, input, vault.env);
    if (!result.ok) throw new Error(`synthetic_review_${command.id}_${result.reason}`);
    return result.value;
  };
  const account = run(C.addBrokerageAccount, {
    name: "Synthetic Review100",
    broker: "manual",
    currency: "PLN",
  }).account;
  const firstDay = addDays(today, -70);
  run(C.addManualTransaction, {
    account,
    type: "deposit",
    tradeDate: firstDay,
    cashAmount: "10000",
    currency: "PLN",
  });
  const ids: string[] = [];
  for (let index = 0; index < 60; index++) {
    const symbol = `RV${String(index).padStart(3, "0")}`;
    const instrument = run(C.createInstrument, {
      name: `Synthetic Review position ${index + 1}`,
      symbol,
      mic: "XWAR",
      currency: "PLN",
      assetClass: "equity",
      aliases: [{ namespace: "yahoo", value: `${symbol}.WA` }],
    }).gid;
    ids.push(instrument);
    run(C.setInstrumentSegment, { instrument, segment: "equity_global", by: "owner" });
    run(C.addManualTransaction, {
      account,
      type: "buy",
      tradeDate: firstDay,
      instrument,
      quantity: "1",
      price: "10",
      cashAmount: "-10",
      currency: "PLN",
    });
    prices.upsertBars(
      market.marketSymbol("yahoo", `${symbol}.WA`),
      Array.from({ length: 71 }, (_, day) => ({
        date: addDays(firstDay, day),
        close: D(day > 63 ? (index % 2 === 0 ? "12" : "8") : day % 2 === 0 ? "10" : "10.1"),
        currency: toCurrency("PLN"),
        open: null,
        high: null,
        low: null,
        volume: null,
        fetchedAt: null,
      })),
      parseDateTime(`${today}T08:00:00Z`),
    );
  }
  const instrument = ids[0];
  if (!instrument) throw new Error("synthetic_review_instrument_missing");
  run(C.createThesis, {
    instrument,
    entryType: "trend",
    thesis: "Synthetic review thesis",
    invalidation: "Synthetic operating margin falls",
  });
  run(research.addResearchNote, {
    instrument,
    createdBy: "agent",
    lang: "en",
    note: {
      kind: "earnings",
      polarity: "negative",
      strength: 3,
      thesis_relation: "weakens",
      thesis_field: "thesis",
      title: "Synthetic review earnings margin contracts",
      summary:
        "Synthetic quarterly results show weaker operating margins and lower cash generation in the manufacturing division.",
      sources: [
        {
          url: "https://example.test/review-earnings",
          publisher: "Synthetic issuer",
          published_at: today,
        },
      ],
    },
  });
  const candidate = run(C.createInstrument, {
    name: "Synthetic Review candidate",
    symbol: "RVC",
    mic: "XWAR",
    currency: "PLN",
    assetClass: "equity",
    aliases: [{ namespace: "yahoo", value: "RVC.WA" }],
  }).gid;
  run(C.setInstrumentSegment, { instrument: candidate, segment: "equity_global", by: "owner" });
  run(research.addResearchNote, {
    instrument: candidate,
    createdBy: "agent",
    lang: "en",
    note: {
      kind: "candidate",
      polarity: "positive",
      strength: 2,
      title: "Synthetic candidate develops a distinct service business",
      summary:
        "Synthetic candidate has growing recurring revenue, a conservative balance sheet and a measurable valuation criterion.",
      sources: [
        {
          url: "https://example.test/review-candidate",
          publisher: "Synthetic issuer",
          published_at: today,
        },
      ],
      details: {
        entry_type: "trend",
        criteria: [
          { text: "Synthetic valuation criterion", met: true, threshold: "Synthetic threshold" },
        ],
        context: "Synthetic recurring revenue expansion",
      },
    },
  });
}
