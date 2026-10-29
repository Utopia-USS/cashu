// Texts of the research actions (src/modules/investments/v2/research/data.ts). See src/i18n.ts.
import { catalog } from "../../../../i18n.ts";

export const S = catalog({
  candidateDismissed: { pl: (name: string) => `Odrzucono kandydata: ${name}`, en: (name: string) => `Candidate dismissed: ${name}` },
  noteDismissed: { pl: "Notatka odrzucona", en: "Note dismissed" },
  whatCandidateDismiss: { pl: "odrzucenie kandydata", en: "dismissing the candidate" },
  whatNoteDismiss: { pl: "odrzucenie notatki", en: "dismissing the note" },
  notDismissed: { pl: (e: string) => `Nie odrzucono: ${e}`, en: (e: string) => `Not dismissed: ${e}` },
  candidateRestored: { pl: "Przywrócono kandydata", en: "Candidate restored" },
  noteRestored: { pl: "Przywrócono notatkę", en: "Note restored" },
  notRestored: { pl: (e: string) => `Nie przywrócono: ${e}`, en: (e: string) => `Not restored: ${e}` },
  /** The watchlist note of a candidate added without the accept endpoint (stored as written). */
  candidateNote: { pl: (title: string) => `kandydat: ${title}`, en: (title: string) => `candidate: ${title}` },
  watched: { pl: (name: string) => `Dodano do obserwowanych: ${name}`, en: (name: string) => `Added to the watchlist: ${name}` },
  whatWatch: { pl: "obserwowanie", en: "watching" },
  notWatched: { pl: (e: string) => `Nie dodano do obserwowanych: ${e}`, en: (e: string) => `Not added to the watchlist: ${e}` },
});
