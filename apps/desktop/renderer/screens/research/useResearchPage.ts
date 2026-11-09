// The research page's screen hook (ab24ab6 v2/research/Page.tsx ResearchPage + index.tsx useResearchHome's
// `page`): the selected tab and the Notatki list state, the old shapes from the Home's reads (the same cached
// queries), the profile's MCP privacy level, the candidate / note actions with their toasts and the copied
// commands. Navigation comes in as callbacks (legacy instrument and note numbers, like the strip's).
import { profile } from "@cashu/store/core";
import { useQuery } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import { instName } from "@cashu/ui-logic/investments/v2/logic";
import { acceptedAt, watchItemId } from "@cashu/ui-logic/investments/v2/research/logic";
import type { ResearchNote } from "@cashu/ui-logic/investments/v2/research/types";
import { useState } from "react";
import { researchNotes } from "../investments/home/homeAdapters.js";
import type { InvestmentsHomeData } from "../investments/home/useInvestmentsHomeData.js";
import { useDisplayClock } from "../signals/useDisplayClock.js";
import {
  type CandidateWatch,
  initialTab,
  type NoteFilter,
  type ResearchPageUi,
  researchPageModel,
  type StoryTab,
} from "./researchPageModel.js";
import { useResearchActions } from "./useResearchActions.js";

export interface ResearchPageOptions {
  data: InvestmentsHomeData;
  slug: string;
  /** `?tab=` of the link. */
  initialTab?: string;
  /** A note to show opened in Notatki (legacy number). */
  initialNote?: number | null;
  onBack(): void;
  onOpenAsset(instrumentId: number, noteId?: number): void;
  /** A segment key or a macro regime's `macro_<key>`: the topic drawer over the Home. */
  onOpenTopic(key: string): void;
  onSettings(): void;
}

interface Named {
  name: string;
  symbol: string | null;
}

export function useResearchPage(o: ResearchPageOptions) {
  const { data } = o;
  const toast = useToast();
  const actions = useResearchActions();
  const mcpPrivacy = useQuery(profile)?.mcpPrivacy ?? "strict";
  const now = Date.parse(useDisplayClock(data.today));
  const [tab, setTab] = useState<StoryTab>(() =>
    o.initialNote != null ? "notes" : initialTab(o.initialTab),
  );
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [openNote, setOpenNote] = useState<number | null>(o.initialNote ?? null);
  const [shown, setShown] = useState(15);
  const [how, setHow] = useState(false);

  const r = data.research;
  const held = new Map<number, Named>(
    (data.pos.data?.positions ?? []).map((p) => [
      Number(p.instrument.id),
      { name: instName(p.instrument), symbol: p.instrument.symbol ?? null },
    ]),
  );
  const watch = data.watchQ.data ?? [];
  const watchedIds = new Map<number, Named>();
  for (const w of watch)
    if (w.instrument)
      watchedIds.set(w.instrument_id, {
        name: instName(w.instrument),
        symbol: w.instrument.symbol ?? null,
      });
  // Old research/index.tsx `watched`: an instrument the agent put on the watchlist shows `dodany przez agenta`.
  const watched = (n: ResearchNote): CandidateWatch | undefined => {
    const sym = (n.candidate?.symbol ?? n.instrument?.symbol)?.toUpperCase();
    const wid = watchItemId(n);
    const w = watch.find(
      (x) =>
        (wid != null && x.id === wid) ||
        (n.instrument_id != null && x.instrument_id === n.instrument_id) ||
        (sym && x.instrument?.symbol?.toUpperCase() === sym),
    );
    if (!w) return acceptedAt(n) ? { watchedSince: acceptedAt(n) } : undefined;
    return {
      watchedSince: acceptedAt(n) ?? w.added_at,
      agent: w.source === "agent" && !acceptedAt(n),
    };
  };
  const symOf = (id: number) =>
    held.get(id)?.symbol ??
    watchedIds.get(id)?.symbol ??
    r.summary?.instruments.find((s) => s.instrument_id === id)?.instrument?.symbol ??
    null;

  const ui: ResearchPageUi = {
    tab,
    onTab: setTab,
    filter,
    onFilter: (f) => {
      setFilter(f);
      setShown(15);
    },
    openNote,
    onToggleNote: (id) => setOpenNote((x) => (x === id ? null : id)),
    shown,
    onMore: () => setShown((s) => s + 15),
    how,
    onHow: () => setHow((v) => !v),
    busy: actions.busy,
    onBack: o.onBack,
    onOpenAsset: o.onOpenAsset,
    onOpenTopic: o.onOpenTopic,
    onSettings: o.onSettings,
    onCopy: (command, done) => {
      void navigator.clipboard.writeText(command).then(
        () => toast(done, 3000),
        () => undefined,
      );
    },
    onWatch: (n) => actions.watch(n),
    onDismiss: (n) => actions.dismiss(n),
    onRestore: (n) => actions.restore(n),
  };
  const model = researchPageModel(
    {
      slug: o.slug,
      today: data.today,
      now,
      privacy: mcpPrivacy,
      hidden: data.privacy,
      runs: r.runs,
      summary: r.summary,
      candidates: r.candidates,
      notes: researchNotes(r.notes),
      segments: r.segments,
      calendar: r.calendar.data
        ? { events: r.calendar.data.events ?? [], stale: !!r.calendar.data.stale }
        : null,
      calendarError: r.calendar.error != null,
      workspace: r.workspace,
      strategyVersion: r.strategyVersion,
      held,
      watchedIds,
      watched,
      symOf,
    },
    ui,
  );
  return { model, ui };
}
