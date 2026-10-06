// Slots of the asset detail (drawer over the grid and "otwórz jako stronę") for other features, so they plug
// in without editing AssetPage.tsx. Research fills them (asset-detail.md 5-6, F9): the `Research` widget in the
// right column next to the Teza / Alerty stack and the health pill in the Teza header.
//
// How to plug in: assign the components below (one edit in this file), e.g.
//   import { AssetResearch, ThesisHealth } from "./research/AssetResearch";
//   export const ASSET_SLOTS: AssetSlots = { Research: AssetResearch, ThesisTags: ThesisHealth };
// Every slot is optional; without `Research` the detail moves the timeline into the right column.
import type { ComponentType } from "react";
import type { Thesis } from "../api";
import { AssetResearch, ThesisHealth, useResearchShown } from "./research/AssetResearch";

export interface AssetSlotProps {
  slug: string;
  instrumentId: number;
  /** Display name (instName) and symbol of the instrument. */
  name: string;
  symbol: string | null;
  /** Held in the portfolio (false: watched or a candidate opened from a link). */
  held: boolean;
  /** The latest thesis record of the position, null when it has none. */
  thesis: Thesis | null;
  /** `?note=<id>` of the deep link (`#/{slug}/investments.portfolio/assets/{id}?note=12`): open that note's row
   * and highlight it. */
  noteId: string | null;
  mode: "drawer" | "page";
  /** Refresh the investments page data (signals, alerts) after a change made in the slot. */
  onChanged: () => void;
  /** The instrument's research notes were marked read (home v3 Q10): the page drops its unread marker. */
  onRead?: (instrumentId: number) => void;
}

export interface AssetSlots {
  /** Right column of the detail's two-column grid (a `section.w` widget, `Research`). */
  Research?: ComponentType<AssetSlotProps>;
  /** Whether `Research` shows for this instrument (a hook, called on every render; watched instruments show it
   * only with notes, asset-detail.md 10). Absent: always. */
  useResearchShown?: (p: AssetSlotProps) => boolean;
  /** Extra tags in the Teza header after the entry type (the thesis health pill). */
  ThesisTags?: ComponentType<AssetSlotProps>;
}

export const ASSET_SLOTS: AssetSlots = { Research: AssetResearch, useResearchShown, ThesisTags: ThesisHealth };
