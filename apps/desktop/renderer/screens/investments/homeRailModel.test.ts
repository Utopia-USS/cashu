import { setLanguageForTests } from "@cashu/i18n";
import type { ReadyReview } from "@cashu/store/investments/review-screen";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storySnapshot } from "../review/storyState.js";
import type { ReviewEntryState } from "../review/useReviewEntry.js";
import { signalsStorySnapshot } from "../signals/storyState.js";
import type { SignalsScreenState } from "../signals/useSignalsScreen.js";
import { homeRailModel } from "./homeRailModel.js";

const signal = signalsStorySnapshot();
const subject = {
  ...storySnapshot().decide.items[0],
  instrument: signal.open[0]?.instrument ?? null,
  fresh: true,
  seenAt: Date.parse(signal.asOf),
  snoozedUntil: null,
};
const reviewData = (items: (typeof subject)[]): ReadyReview =>
  ({
    ...storySnapshot(),
    cards: [],
    railDecide: { items, more: 0, rest: { review: 1, research: 0 }, total: 2 },
  }) as ReadyReview;
const state = (data: typeof signal): SignalsScreenState =>
  ({
    data,
    setDialogOpen: vi.fn(),
    setCursor: vi.fn(),
    setEditingAlert: vi.fn(),
  }) as unknown as SignalsScreenState;
const review = (data: ReadyReview): ReviewEntryState => ({ data }) as unknown as ReviewEntryState;
beforeEach(() => setLanguageForTests("en"));

describe("native investments Home rail mapping", () => {
  it("uses the full open count, ticker tile and nonempty decide deck to show a due review", () => {
    const openAsset = vi.fn();
    const newAlert = vi.fn();
    const model = homeRailModel(
      state(signal),
      review(reviewData([subject])),
      vi.fn(),
      vi.fn(),
      newAlert,
      openAsset,
    );
    expect(model.signals).toMatchObject({ available: true, fresh: 1, left: 0, total: 2 });
    expect(model.signals.review).not.toBeNull();
    expect(model.signals.rows[0]?.tile).toBe("SYN");
    model.signals.rows[0]?.onOpen();
    expect(openAsset).toHaveBeenCalledWith(signal.open[0]?.instrument);
    expect(model.alerts.active).toBe(1);
    expect(model.alerts.rows[0]?.note).toContain("Nov 3");
    model.alerts.onNew();
    expect(newAlert).toHaveBeenCalledOnce();
  });

  it("shows only the old undecided subject carried from a review", () => {
    const reviewed = "2026-11-03T12:00:00Z";
    const data = { ...signal, lastReviewAt: reviewed };
    const model = homeRailModel(
      state(data),
      review(
        reviewData([
          { ...subject, key: "left", fresh: false, seenAt: Date.parse("2026-11-02T12:00:00Z") },
          { ...subject, key: "later", fresh: false, seenAt: Date.parse("2026-11-03T13:00:00Z") },
        ]),
      ),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(model.signals.left).toBe(1);
    expect(model.signals.rows.map((row) => row.id)).toEqual(["left"]);
  });

  it("uses an explicit near threshold when supplied and excludes farther active alerts", () => {
    const active = {
      ...signal.alerts[0],
      status: "active" as const,
      lastTriggeredAt: null,
      lastValue: "140",
    };
    const data = { ...signal, alerts: [active] } as typeof signal;
    const args = [state(data), review(reviewData([])), vi.fn(), vi.fn(), vi.fn()] as const;
    expect(homeRailModel(...args).alerts.rows).toHaveLength(1);
    expect(homeRailModel(...args, undefined, { pricePct: 1 }).alerts.rows).toHaveLength(0);
  });

  it("keeps raw Signals navigation available with zero signals and an unbound review source", () => {
    const setDialogOpen = vi.fn();
    const data = { ...signal, open: [], signals: [] };
    const signals = {
      data,
      setDialogOpen,
      setCursor: vi.fn(),
      setEditingAlert: vi.fn(),
    } as unknown as SignalsScreenState;
    const unbound = {
      data: { status: "unavailable", reason: "source_unbound" },
    } as unknown as ReviewEntryState;
    const model = homeRailModel(signals, unbound, vi.fn(), vi.fn(), vi.fn());
    expect(model.signals).toMatchObject({
      available: false,
      navigationAvailable: true,
      total: 0,
    });
    model.signals.onAll();
    expect(setDialogOpen).toHaveBeenCalledWith(true);
  });
});
