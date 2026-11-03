import { D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { formatDecimalValue } from "@cashu/i18n/values";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AssetDetailView } from "./AssetDetailView.js";
import { PortfolioView } from "./PortfolioView.js";
import { readyAsset, readyPortfolio, StoryFixture } from "./storyState.js";

it("keeps a watched quote in its quoted currency while held portfolio values use the base", () => {
  setLanguageForTests("en");
  if (readyPortfolio.status !== "ready" || readyAsset.status !== "ready")
    throw new Error("synthetic fixture absent");
  const portfolio = {
    ...readyPortfolio,
    watch: [
      {
        id: "d".repeat(32),
        instrument_id: readyAsset.detail.instrument.id,
        instrument: readyAsset.detail.instrument,
        note: null,
        tags: [],
        source: "user",
        added_at: null,
        held: false,
        price_source: true,
        price: {
          close: D("12"),
          currency: "USD",
          date: "2026-11-01",
          stale: false,
          change_1d: null,
          change_1m: null,
          high_52w: D("15"),
          high_52w_date: "2026-10-01",
          from_high_52w: null,
          bars: 1,
        },
        closes_30d: [],
        alerts: { count: 0, live: 0, triggered: 0, nearest: null },
        research_unread: 0,
        hints: [],
      },
    ],
  };
  const markup = renderToStaticMarkup(
    <StoryFixture component={PortfolioView} state={{ portfolio, tab: "watch" }} />,
  );
  expect(markup).toContain(formatDecimalValue(D("12"), "en-US", { currency: "USD" }).text);
});

it.each(["pl", "en"] as const)(
  "renders timestamped thesis facts as calendar dates and suppresses prose privately (%s)",
  (language) => {
    setLanguageForTests(language);
    if (readyAsset.status !== "ready") throw new Error("synthetic ready fixture absent");
    const asset = {
      ...readyAsset,
      detail: {
        ...readyAsset.detail,
        theses: [
          {
            id: "c".repeat(32),
            instrument_id: readyAsset.detail.instrument.id,
            entry_type: "trend",
            thesis: "Synthetic private thesis",
            invalidation: "Synthetic private boundary",
            exit_plan: null,
            size_plan: null,
            created_at: "2026-11-01T12:00:00Z",
            updated_at: "2026-11-03T12:00:00Z",
            core_changed_at: "2026-11-01T12:00:00Z",
            exit_plan_changed_at: null,
            reviewed_at: "2026-11-03T12:00:00Z",
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <StoryFixture
        component={AssetDetailView}
        state={{ asset, isPage: true, selected: asset.detail.instrument.id }}
      />,
    );
    expect(markup).toContain("Synthetic private thesis");
    const privateMarkup = renderToStaticMarkup(
      <StoryFixture
        component={AssetDetailView}
        state={{ asset, isPage: true, privacy: true, selected: asset.detail.instrument.id }}
      />,
    );
    expect(privateMarkup).not.toMatch(/Synthetic private|Synthetic fund|Synthetic brokerage/);
  },
);
