// The research note reader's hook: one note live from the vault (its verdict on the thesis, subject,
// kind and day, title, the plain-text summary split into paragraphs, the paragraph that quotes the
// owner's thesis set apart as a quote, and the sources), marked read when it opens (fire and forget: a
// refusal changes nothing on the page). Links open through the route; only http(s) and mailto links are
// offered.
import type { core, IsoDate } from "@cashu/domain";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import { useCommand, useQuery } from "@cashu/store-react";
import { type TagTone, useUiEnv } from "@cashu/ui/native";
import { safeHref } from "@cashu/ui-logic/core/markdown";
import { useEffect, useRef } from "react";
import { deviceTimeZone } from "../../services/investments";
import { useServices } from "../../services/ServicesProvider";
import { RELATION } from "../alert/Alert.strings";
import { dayOf, dayText } from "../alert/display";
import { KIND, S } from "./Note.strings";

/** The research commands without plan inputs (the phone stages no derived plan signals). */
const research = researchScreenCommands();

const RELATION_TONES: Readonly<Record<string, TagTone>> = {
  weakens: "negative",
  invalidates: "negative",
  supports: "positive",
  fulfills: "positive",
};

/** A source field as text (sources are stored as the agent sent them). */
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A thesis text shorter than this is not looked for in the note (too likely to match by chance). */
const MIN_QUOTED = 12;

export type NoteBlock = {
  readonly key: string;
  readonly kind: "p" | "quote";
  readonly text: string;
};

/** The summary's paragraphs; the first one quoting a thesis text becomes the quote. */
export function noteBlocks(
  summary: string,
  quoted: readonly string[],
  locale: string,
): NoteBlock[] {
  const paragraphs = summary
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter((text) => text !== "");
  const quote = paragraphs.findIndex((text) => {
    const lower = text.toLocaleLowerCase(locale);
    return quoted.some((q) => lower.includes(q));
  });
  return paragraphs.map((text, i) => ({ key: `${i}`, kind: i === quote ? "quote" : "p", text }));
}

export type NoteState =
  | { readonly kind: "missing" }
  | {
      readonly kind: "ready";
      readonly tag: { readonly text: string; readonly tone: TagTone };
      /** "CD Projekt · news · Nov 7, 2026". */
      readonly meta: string;
      readonly title: string;
      readonly blocks: readonly NoteBlock[];
      readonly sources: readonly {
        readonly key: string;
        readonly title: string;
        /** Null for a link the phone does not open (not http(s) or mailto). */
        readonly onPress: (() => void) | null;
      }[];
      readonly byAgent: boolean;
    };

export function useNoteScreen(args: {
  readonly gid: string;
  readonly lang: core.UiLang;
  readonly today: IsoDate;
  readonly now: string;
  openLink(url: string): void;
}): NoteState {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const { today, lang } = args;
  const result = useQuery(moneyQueries.investments.research.note, { today, lang, note: args.gid });
  const screen = useQuery(moneyQueries.investments.signals, {
    now: args.now,
    today,
    timeZone: deviceTimeZone(),
    lang,
    privacy: false,
  });
  const markRead = useCommand(research.markRead);
  const note = result.status === "current" ? (result.note ?? null) : null;
  const unread = note?.unread === true;
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!unread || marked.current === args.gid) return;
    marked.current = args.gid;
    // Fire and forget: a refused or unknown outcome leaves the note unread, nothing to show.
    void markRead.run({ ids: [args.gid] });
  }, [unread, args.gid, markRead]);
  if (note === null) return { kind: "missing" };

  // The owner's thesis texts for this instrument (a paragraph quoting one becomes the quote).
  const thesis =
    screen.status === "ready" && note.instrument_id !== null
      ? (screen.theses.find((t) => t.instrument === note.instrument_id) ?? null)
      : null;
  const quoted = [thesis?.invalidation, thesis?.thesis, thesis?.sizePlan, thesis?.exitPlan]
    .filter((text): text is string => typeof text === "string" && text.length >= MIN_QUOTED)
    .map((text) => text.toLocaleLowerCase(locale));
  const blocks = noteBlocks(note.summary, quoted, locale);

  const tone = RELATION_TONES[note.thesis_relation];
  const tag =
    tone !== undefined
      ? { text: S.thesisTag(RELATION[note.thesis_relation as keyof typeof RELATION]), tone }
      : note.kind === "candidate"
        ? { text: S.idea, tone: "info" as const }
        : { text: S.background, tone: "neutral" as const };
  const subject =
    note.instrument?.name ?? note.instrument?.label ?? note.segment_label ?? note.theme ?? S.market;
  const kind = (KIND as Record<string, string | undefined>)[note.kind] ?? note.kind;
  const day = dayText(dayOf(note.observed_at ?? note.created_at ?? args.now), locale);

  return {
    kind: "ready",
    tag,
    meta: S.noteMeta(subject, kind, day),
    title: note.title,
    blocks,
    sources: note.sources.map((source, i) => {
      const url = text(source.url);
      const name = text(source.title) || text(source.publisher) || url;
      const published = text(source.published_at).slice(0, 10);
      const href = url === "" ? null : safeHref(url);
      return {
        key: `${i}:${url || name}`,
        title: /^\d{4}-\d{2}-\d{2}$/.test(published)
          ? S.source(name, dayText(published, locale))
          : name,
        onPress: href === null ? null : () => args.openLink(href),
      };
    }),
    byAgent: note.created_by === "agent",
  };
}
