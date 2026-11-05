import { D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AssetDetailView } from "./AssetDetailView.js";
import { readyAsset, StoryFixture } from "./storyState.js";

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
