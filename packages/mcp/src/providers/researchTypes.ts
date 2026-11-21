/** Typed native research inputs/results only; no dependency on a tool handler or runtime context. */

import type * as macro from "@cashu/domain/investments/macro";
import type { investmentsResearch, investmentsViews } from "@cashu/store";
import type { ResearchPlanInputs } from "@cashu/store/investments/services";

export interface ResearchRequests {
  readonly portfolio: Parameters<typeof investmentsViews.readPositions>[1];
  /** Actual stored public closes; an empty record means missing data, never fabricated regimes. */
  readonly macroCloses: macro.MacroCloses;
  readonly markdown?: string | null;
  isHolder(vault: string): boolean;
}

export interface ResearchServices {
  readonly vault: string;
  readonly strategy: ResearchRequests["portfolio"]["strategy"];
  readonly markdown: string | null;
  readonly plans: ResearchPlanInputs;
  positions(): Extract<ReturnType<typeof investmentsViews.readPositions>, { ok: true }>["value"];
  segments(
    window: "1w" | "4w",
  ): Extract<ReturnType<typeof investmentsResearch.segmentsView>, { ok: true }>["value"];
  macro(): readonly (macro.RegimeDict & {
    readonly brief: ReturnType<typeof investmentsResearch.macroBrief>;
    readonly last_note_at: string | null;
    readonly note_this_week: boolean;
  })[];
  isHolder(vault: string): boolean;
}
