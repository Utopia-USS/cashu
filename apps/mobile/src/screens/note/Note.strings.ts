// The research note reader: one note the research agent wrote on the Mac, its verdict on the thesis and
// its sources. The note's own text is shown as written. PL + EN.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  note: { pl: "Notatka", en: "Note" },
  missing: { pl: "Tej notatki już nie ma", en: "This note is gone" },
  thesisTag: {
    pl: (verb: string) => `${verb} Twoją tezę`,
    en: (verb: string) => `${verb} your thesis`,
  },
  background: { pl: "tło", en: "background" },
  idea: { pl: "pomysł", en: "idea" },
  noteMeta: {
    pl: (subject: string, kind: string, day: string) => `${subject} · ${kind} · ${day}`,
    en: (subject: string, kind: string, day: string) => `${subject} · ${kind} · ${day}`,
  },
  market: { pl: "Rynek", en: "Market" },
  sources: { pl: "Źródła", en: "Sources" },
  source: {
    pl: (title: string, day: string) => `${title} - ${day}`,
    en: (title: string, day: string) => `${title} - ${day}`,
  },
  writtenByAgent: {
    pl: "Napisane przez Twojego agenta researchu na Macu.",
    en: "Written by your research agent on your Mac.",
  },
  writtenByYou: { pl: "Twoja notatka z Maca.", en: "Your own note from your Mac." },
});

/** The kind of a research note, as its meta line names it. */
export const KIND = catalog({
  news: { pl: "wiadomości", en: "news" },
  earnings: { pl: "wyniki", en: "earnings" },
  community: { pl: "społeczność", en: "community" },
  trend: { pl: "trend", en: "trend" },
  macro: { pl: "makro", en: "macro" },
  candidate: { pl: "pomysł", en: "idea" },
});
