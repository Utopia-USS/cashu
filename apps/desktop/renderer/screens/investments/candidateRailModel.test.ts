import type { ResearchScreenSnapshot } from "@cashu/store/investments/research-screen";
import { describe, expect, it, vi } from "vitest";
import { candidateRailModel } from "./candidateRailModel.js";

const now = Date.parse("2026-11-04T12:00:00Z");
const note = (id: string, changes: Record<string, unknown> = {}) => ({
  id,
  kind: "candidate",
  title: `Synthetic ${id}`,
  details: { headline: `Headline ${id}`, brief: { headline: `Brief ${id}` }, criteria: [] },
  candidate: { name: `Candidate ${id}`, symbol: id, accepted_at: null },
  instrument: null,
  instrument_id: null,
  sources: [],
  observed_at: "2026-11-04T11:00:00Z",
  dismissed: false,
  expired: false,
  expires_at: "2026-11-30T00:00:00Z",
  watched: false,
  ...changes,
});
const snapshot = (...notes: ReturnType<typeof note>[]) =>
  ({ status: "current", notes }) as unknown as ResearchScreenSnapshot;

describe("native candidate Home rail", () => {
  it("uses only fresh candidates when any exist and excludes dismissed or expired rows", () => {
    const watch = vi.fn();
    const model = candidateRailModel(
      snapshot(
        note("fresh"),
        note("watched", { watched: true }),
        note("linked", {
          candidate: { name: "Linked", symbol: "LNK", accepted_at: null, watchlist_item_id: 7 },
        }),
        note("dismissed", { dismissed: true }),
        note("expired", { expires_at: "2026-11-04T12:00:00Z" }),
      ),
      false,
      { busy: false, notice: null, watch, dismiss: vi.fn() },
      vi.fn(),
      vi.fn(),
      now,
    );
    expect(model.totalOpen).toBe(3);
    expect(model.freshCount).toBe(1);
    expect(model.rows.map((row) => row.id)).toEqual(["fresh"]);
    expect(model.rows[0]?.sentence).toBe("Headline fresh");
    model.rows[0]?.onWatch();
    expect(watch).toHaveBeenCalledWith("fresh", null);
  });

  it("falls back to open watched candidates and the brief headline when none is fresh", () => {
    const model = candidateRailModel(
      snapshot(note("watched", { watched: true, details: { brief: { headline: "Brief only" } } })),
      false,
      { busy: false, notice: null, watch: vi.fn(), dismiss: vi.fn() },
      vi.fn(),
      vi.fn(),
      now,
    );
    expect(model.freshCount).toBe(0);
    expect(model.rows.map((row) => [row.id, row.sentence])).toEqual([["watched", "Brief only"]]);
    expect(model.rows[0]?.watched).toBe(true);
  });

  it("treats a linked watchlist item as already watched even without a watched flag", () => {
    const model = candidateRailModel(
      snapshot(
        note("linked", {
          candidate: { name: "Linked", symbol: "LNK", accepted_at: null, watchlist_item_id: 7 },
        }),
      ),
      false,
      { busy: false, notice: null, watch: vi.fn(), dismiss: vi.fn() },
      vi.fn(),
      vi.fn(),
      now,
    );
    expect(model.freshCount).toBe(0);
    expect(model.rows[0]).toMatchObject({ id: "linked", watched: true });
  });
});
