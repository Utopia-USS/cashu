import type { ResearchScreenSnapshot } from "@cashu/store/investments/research-screen";
import { researchNoteFacts } from "../research/presentation.js";
import type { CandidatesRailViewProps } from "./home-rail/CandidatesRailView.js";

type Actions = Pick<CandidatesRailViewProps, "notice"> & {
  readonly busy: boolean;
  watch(note: string, instrument: string | null): void;
  dismiss(note: string): void;
};
const field = (value: unknown, key: string): string | null => {
  if (value === null || typeof value !== "object") return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found.trim() ? found.trim() : null;
};

/** Fresh candidates take the whole three-row rail when present; no stale filler is added. */
export function candidateRailModel(
  data: ResearchScreenSnapshot,
  privacy: boolean,
  actions: Actions,
  onAll: () => void,
  onOpenNote: (gid: string) => void,
  now: number,
): CandidatesRailViewProps {
  if (data.status !== "current")
    return {
      privacy,
      available: false,
      freshCount: 0,
      totalOpen: 0,
      rows: [],
      notice: actions.notice,
      onAll,
    };
  const open = data.notes.filter(
    (note) =>
      note.kind === "candidate" &&
      !note.dismissed &&
      !note.expired &&
      (note.expires_at === null || Date.parse(note.expires_at) > now),
  );
  const fresh = open.filter(
    (note) =>
      !note.watched && !note.candidate?.accepted_at && note.candidate?.watchlist_item_id == null,
  );
  const source = fresh.length > 0 ? fresh : open;
  const shown = [...source]
    .sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""))
    .slice(0, 3);
  return {
    privacy,
    available: true,
    freshCount: fresh.length,
    totalOpen: open.length,
    rows: shown.map((note) => {
      const facts = researchNoteFacts(note);
      const met = facts.criteria
        .filter((item) => item.met)
        .slice(0, 2)
        .map((item) => item.text)
        .join(" · ");
      const sentence =
        field(note.details, "headline") ??
        field(note.details?.brief, "headline") ??
        facts.context ??
        (met || note.title);
      return {
        id: note.id,
        tile: facts.candidateSymbol ?? note.instrument?.symbol ?? "?",
        name: facts.candidateName ?? note.instrument?.name ?? note.title,
        sentence,
        watched:
          note.watched ||
          !!note.candidate?.accepted_at ||
          note.candidate?.watchlist_item_id != null,
        busy: actions.busy,
        criteria: facts.criteria,
        context: facts.context,
        onWatch: () => actions.watch(note.id, note.instrument_id),
        onDismiss: () => actions.dismiss(note.id),
        onOpen: () => onOpenNote(note.id),
      };
    }),
    notice: actions.notice,
    onAll,
  };
}
