// Slots of the asset detail (drawer over the grid and "otwórz jako stronę") for other features, so they plug
// in without editing AssetPage.tsx. Research (F6 track FE-RS, design/v2/research/research.md section 1,
// implementation-plan item 32) fills them: the `Research · <symbol>` widget in the right column next to the
// Teza / Alerty / Loty stack, the health pill in the Teza header, a relation chip after a thesis field, a
// header note and research entries in the "Sygnały i decyzje" timeline.
//
// How to plug in: assign the components below (one edit in this file), e.g.
//   import { AssetResearch, ThesisHealth } from "./research/AssetResearch";
//   export const ASSET_SLOTS: AssetSlots = { Research: AssetResearch, ThesisTags: ThesisHealth };
// Every slot is optional; without `Research` the drawer moves the timeline into the right column.
import type { ComponentType } from "react";
import type { Thesis } from "../api";
import { AssetResearch, ResearchHeaderNote, ThesisFieldChip, ThesisHealth, useResearchTimeline } from "./research/AssetResearch";

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
  /** `?note=<id>` of the deep link (`#/{slug}/investments.portfolio/assets/{id}?note=12`): scroll to that
   * note and highlight it. */
  noteId: string | null;
  mode: "drawer" | "page";
  /** Refresh the investments page data (signals, alerts) after a change made in the slot. */
  onChanged: () => void;
}

export type ThesisField = "entry" | "invalidation" | "exit" | "size";

/** One extra row of the "Sygnały i decyzje" timeline (newest first after merging by `at`). */
export interface AssetTimelineEntry {
  /** ISO timestamp or date. */
  at: string;
  /** Dot colour: polarity (pos / neg), "nw" for the owner's own actions, "" grey. */
  dot: "pos" | "neg" | "nw" | "";
  head: string;
  main?: string;
  tail?: string;
  action?: { label: string; onClick: () => void };
}

export interface AssetSlots {
  /** Right column of the drawer's two-column grid (a `section.w` widget, e.g. `Research · CDR`). */
  Research?: ComponentType<AssetSlotProps>;
  /** Extra tags in the Teza header after the entry type (the thesis health pill). */
  ThesisTags?: ComponentType<AssetSlotProps>;
  /** Inline chip after one thesis field (`1 notatka osłabia` on Wejście). */
  ThesisFieldChip?: ComponentType<AssetSlotProps & { field: ThesisField }>;
  /** Extra notes in the asset header's polarity line (`research osłabia tezę`). */
  HeaderNote?: ComponentType<AssetSlotProps>;
  /** Extra timeline rows; a hook (called on every render of the asset detail, so keep it unconditional). */
  useTimeline?: (p: AssetSlotProps) => AssetTimelineEntry[];
}

export const ASSET_SLOTS: AssetSlots = {
  Research: AssetResearch, ThesisTags: ThesisHealth, ThesisFieldChip, HeaderNote: ResearchHeaderNote, useTimeline: useResearchTimeline,
};
