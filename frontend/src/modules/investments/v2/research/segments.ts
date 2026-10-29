// P5 market segments, P7 "Tematy" (design/P5/segments-design.md, design/P7/strip-design.md): the catalog (kept in sync with the BE
// `INV/research/segments.py`), the tolerant reading of `GET .../research/segments`, the contribution tone and
// text, the diverging bar geometry, the row selection of the home / review column and the page widget, the sub
// line and the tooltips. Pure; `npm test` imports it (imports carry .ts).
import { dateParts, dm, pp } from "../../labels.ts";
import type { NoteSource, SegmentAttribution, SegmentInstrument, SegmentMember, SegmentNoteRef, SegmentRow, SegmentWindow, TopicBrief, TopicThesis } from "./types.ts";

export type SegmentGroup = "asset" | "sector";

export const SEGMENTS: { key: string; label: string; group: SegmentGroup }[] = [
  { key: "equity_global", label: "Akcje globalne", group: "asset" }, { key: "equity_pl", label: "Akcje polskie", group: "asset" },
  { key: "equity_em", label: "Rynki wschodzące", group: "asset" }, { key: "bonds", label: "Obligacje i stopy", group: "asset" },
  { key: "gold", label: "Złoto i górnicy", group: "asset" }, { key: "energy", label: "Ropa i gaz", group: "asset" },
  { key: "power", label: "Energetyka: atom i OZE", group: "asset" }, { key: "metals", label: "Metale i ziemie rzadkie", group: "asset" },
  { key: "crypto", label: "Krypto", group: "asset" }, { key: "real_estate", label: "Nieruchomości", group: "asset" },
  { key: "semis_ai", label: "AI: chipy i centra danych", group: "sector" }, { key: "software", label: "AI i oprogramowanie", group: "sector" },
  { key: "robotics", label: "Robotyka", group: "sector" },
  { key: "healthcare", label: "Ochrona zdrowia", group: "sector" }, { key: "financials", label: "Płatności i finanse", group: "sector" },
  { key: "consumer", label: "Konsumpcja", group: "sector" }, { key: "games_media", label: "Gry", group: "sector" },
  { key: "industrials", label: "Przemysł i obronność", group: "sector" }, { key: "quantum", label: "Komputery kwantowe", group: "sector" },
];
/** Renamed keys still found in old URLs, notes or an older server payload. */
export const LEGACY_KEYS: Record<string, string> = { uranium: "power" };
export const canonKey = (key: string | null | undefined): string | null => (key ? LEGACY_KEYS[key] ?? key : null);
export const isSegment = (key: string | null | undefined): boolean => !!key && SEGMENTS.some((s) => s.key === canonKey(key));
/** Catalog label (a renamed key reads as its new topic); unknown keys as they are. P7: no label for the unassigned
 * bucket, it is never shown. */
export const segmentLabel = (key: string | null | undefined): string => SEGMENTS.find((s) => s.key === canonKey(key))?.label ?? key ?? "";

// ---- tone and text ----------------------------------------------------------------------------------------

/** One-decimal rounding of a fraction in percent, symmetric around zero (-0.0005 -> -0.1, not -0). */
const round1 = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 1000)) / 10;

export type PpTone = "pos" | "neg" | "zero";
/** Tone of a contribution (fraction): `zero` when it rounds to 0,0 pp. */
export function ppTone(c: number | null | undefined): PpTone {
  if (c == null || !Number.isFinite(c)) return "zero";
  const r = round1(c);
  return r >= 0.1 ? "pos" : r <= -0.1 ? "neg" : "zero";
}
/** Contribution (fraction) -> `+0,4 pp` / `-0,8 pp` / `0,0 pp`, rounded like `ppTone`. */
export const ppOf = (c: number | null | undefined): string => (c == null || !Number.isFinite(c) ? "-" : pp(round1(c)));

/** Tone class of a return / portfolio move, with the rounding of `pct` (labels.ts) so the colour matches the text:
 * `pos` / `neg` when `pct` shows a non-zero value, else none. */
export function tone(v: number | null | undefined): "pos" | "neg" | "" {
  if (v == null || !Number.isFinite(v)) return "";
  const p = Math.round(v * 1000) / 10;
  return p > 0.04 ? "pos" : p < -0.04 ? "neg" : "";
}

// ---- diverging bar ----------------------------------------------------------------------------------------

/** Floor of the scale: 0,5 pp. A quiet week stays visually quiet (0,1 pp = one fifth of a half bar), a 0,8 pp
 * week fills its half. Bars are drawn only when the rounded value is not 0,0 pp. Returns widths as % of the
 * whole bar (max 50 = a full half). */
export const BAR_FLOOR = 0.005;
export function contribBars(values: number[], floor = BAR_FLOOR): { max: number; bars: { cls: PpTone; w: number }[] } {
  const max = Math.max(floor, ...values.map((v) => Math.abs(v)));
  const bars = values.map((v) => {
    const cls = ppTone(v);
    return { cls, w: cls === "zero" ? 0 : Math.max(2, Math.round((Math.abs(v) / max) * 500) / 10) };
  });
  return { max, bars };
}
/** `wkład -0,8 pp · skala ±2,0 pp` (the scale is explained only here). */
export const barTitle = (c: number, max: number) => `wkład ${ppOf(c)} · skala ±${pp(max * 100).replace(/^\+/, "")}`;

// ---- rows -------------------------------------------------------------------------------------------------

/** One rendered topic row (P7: only catalog topics; Waluty is a page footer line, unassigned instruments are not shown). */
export interface DisplayRow {
  key: string;
  kind: "segment";
  label: string;
  weight: number;
  contribution: number;
  return: number | null;
  instruments: SegmentInstrument[];
  note: SegmentNoteRef | null;
  note_this_week: boolean;
  /** Newest stored note, expired included (the small date of the note line). */
  last_note_at?: string | null;
  unread: number;
  /** P7 topic trend (equal weights, held and watched members) and the member count. */
  trend_1w?: number | null;
  trend_4w?: number | null;
  members?: number;
  /** P7 BE extra: the priced members (held now / watched); absent on older servers. */
  member_instruments?: SegmentMember[];
  /** P9: the topic's latest brief notes (newest first, max 3) and its thesis. */
  briefs?: TopicBrief[];
  thesis?: TopicThesis | null;
}

export const segmentDisplay = (s: SegmentRow): DisplayRow => ({
  key: s.segment, kind: "segment", label: s.label || segmentLabel(s.segment), weight: s.weight, contribution: s.contribution, return: s.return,
  instruments: s.instruments, note: s.note, note_this_week: s.note_this_week, last_note_at: s.last_note_at ?? null, unread: s.unread,
  trend_1w: s.trend_1w ?? null, trend_4w: s.trend_4w ?? null, members: s.members ?? 0,
  ...(s.member_instruments ? { member_instruments: s.member_instruments } : {}),
  briefs: s.briefs ?? [], thesis: s.thesis ?? null,
});

/** Topics with held exposure at the window start (the `Tematy · N` count). */
export const exposed = (d: Pick<SegmentAttribution, "segments"> | null | undefined): number => (d?.segments ?? []).filter((s) => s.weight > 0).length;
/** Segments with a note this week. */
export const withNewNote = (rows: Pick<SegmentRow, "note_this_week">[] | null | undefined): number => (rows ?? []).filter((s) => s.note_this_week).length;

// ---- sub line, tooltips -----------------------------------------------------------------------------------

export type SymOf = (id: number) => string | null;
/** Symbol of an attributed instrument: the profile's symbol, else the BE label (a position sold inside the window). */
export const instSymbol = (i: Pick<SegmentInstrument, "instrument_id" | "label">, symOf: SymOf): string => symOf(i.instrument_id) ?? i.label ?? `#${i.instrument_id}`;
export const symbolsOf = (instruments: SegmentInstrument[], symOf: SymOf): string[] => instruments.map((i) => instSymbol(i, symOf));

/** Symbols of a row's instruments with a stale price; a row is marked when any is stale. */
export const staleSymbols = (r: Pick<DisplayRow, "instruments">, stale: number[], symOf: SymOf): string[] =>
  r.instruments.filter((i) => stale.includes(i.instrument_id)).map((i) => instSymbol(i, symOf));
export const staleTitle = (syms: string[]) => (syms.length ? `notowania nieaktualne: ${syms.join(", ")}` : undefined);

/** P7 (review LOW-2): one short line when the rows do not add up to the move (|residual| >= 0,1 pp): the gap comes
 * from transactions and position imports inside the window. Null otherwise. */
export const residualLine = (d: Partial<Pick<SegmentAttribution, "residual">>): string | null =>
  d.residual != null && ppTone(d.residual) !== "zero" ? `reszta ${ppOf(d.residual)}: transakcje i import pozycji` : null;

/** Home header tooltip: `1.10 - 8.10 · TWR portfela` (+ `· brak pełnej historii` without the portfolio move), plus the
 * residual line when it applies. */
export const windowTitle = (d: Pick<SegmentAttribution, "start" | "end" | "portfolio_return"> & Partial<Pick<SegmentAttribution, "residual">>) =>
  [`${dm(d.start)} - ${dm(d.end)} · TWR portfela${d.portfolio_return == null ? " · brak pełnej historii" : ""}`, residualLine(d)].filter(Boolean).join("\n");

// ---- topics (P7 design 1.3) --------------------------------------------------------------------------------

export type TopicKind = "held" | "new" | "watched" | "none";
/** A member of the row is held now (BE `member_instruments`, held at the window end). */
export const heldNow = (r: Pick<DisplayRow, "member_instruments">): boolean => !!r.member_instruments?.some((m) => m.held);

/** held = exposure at the window start; new = no exposure at the start but a member held now (bought inside the window:
 * not muted, not `tylko obserwowane`, no contribution); watched = priced members, none held; none = a note-only row. */
export const topicKind = (r: Pick<DisplayRow, "weight" | "members" | "member_instruments">): TopicKind =>
  r.weight > 0 ? "held" : heldNow(r) ? "new" : (r.members ?? 0) > 0 ? "watched" : "none";
const KIND_RANK: Record<TopicKind, number> = { held: 0, new: 1, watched: 2, none: 3 };

/** P9 review MED-6: a topic without held / watched members is still shown when research wrote about it (an active
 * brief) or it has a thesis: a muted row after the watched-only ones (name, briefs; no tickers, no pp). */
export const topicShown = (r: Pick<DisplayRow, "weight" | "members" | "member_instruments" | "briefs" | "thesis">): boolean =>
  topicKind(r) !== "none" || !!r.briefs?.length || !!r.thesis;

/** The latest owner-facing activity on a topic. A note's observed date is intentionally the date of the
 * fact it describes, so a newly created thesis can be newer than `last_note_at`. */
const topicActivityAt = (r: Pick<DisplayRow, "last_note_at" | "thesis">): string => {
  const note = r.last_note_at ?? "";
  const thesis = r.thesis?.updated_at ?? "";
  return note.localeCompare(thesis) >= 0 ? note : thesis;
};

/** Home column: latest research / thesis activity first, then held topics, new and watched-only, then
 * brief-only topics (`topicShown`). This makes a topic the owner just asked to research immediately visible
 * instead of burying it below portfolio topics, even when the sourced fact has an older observation date.
 * P9: no cap (the column is the last widget and expands). No Waluty, no unassigned. */
export function homeTopics(d: Pick<SegmentAttribution, "segments">): DisplayRow[] {
  return d.segments.map(segmentDisplay).filter(topicShown).sort((a, b) =>
    topicActivityAt(b).localeCompare(topicActivityAt(a))
    || KIND_RANK[topicKind(a)] - KIND_RANK[topicKind(b)]
  );
}
/** Review column: rows with a new note first, then the rest; held, new, watched, brief-only inside each group; max 6;
 * no fixed rows. */
export function reviewTopics(segments: SegmentRow[], max = 6): DisplayRow[] {
  const rows = segments.map(segmentDisplay).filter(topicShown);
  const rank = (r: DisplayRow) => (r.note_this_week ? 0 : 3) + KIND_RANK[topicKind(r)];
  return rows.sort((a, b) => rank(a) - rank(b)).slice(0, max);
}
/** P9 review: the digest rows without `briefs` / `thesis` (older digest) take them from the live topic rows. */
export function withBriefs(rows: DisplayRow[], live: Pick<SegmentRow, "segment" | "briefs" | "thesis">[]): DisplayRow[] {
  return rows.map((r) => {
    const l = live.find((x) => x.segment === r.key);
    if (!l) return r;
    return { ...r, briefs: r.briefs?.length ? r.briefs : l.briefs ?? [], thesis: r.thesis ?? l.thesis ?? null };
  });
}
/** Name tooltip of a row: `tylko obserwowane` (watched-only) / `nowa pozycja w tym oknie` (new). */
export const kindTitle = (kind: TopicKind): string | undefined =>
  kind === "watched" ? "tylko obserwowane" : kind === "new" ? "nowa pozycja w tym oknie" : undefined;

/** `held`: held at the window start or now (clickable to the asset); `member`: the BE member entry, when any. */
export interface TopicSym { symbol: string; id: number | null; held: boolean; member?: SegmentMember }
/** Members of a topic row, as symbols: the start-held instruments (BE order, by |contribution|), then the BE
 * `member_instruments` held now, then the watched ones; without `member_instruments` (older server) the watchlist
 * map (`watched`: topic key -> watched symbols) is the fallback. No symbol twice. */
export function topicMembers(r: Pick<DisplayRow, "key" | "instruments" | "member_instruments">, symOf: SymOf, watched: Map<string, string[]>): TopicSym[] {
  const out: TopicSym[] = r.instruments.map((i) => ({ symbol: instSymbol(i, symOf), id: i.instrument_id, held: true }));
  const add = (x: TopicSym) => { if (!out.some((o) => o.symbol === x.symbol || (x.id != null && o.id === x.id))) out.push(x); };
  const members = r.member_instruments;
  if (members) {
    const sym = (m: SegmentMember) => symOf(m.instrument_id) ?? m.label ?? `#${m.instrument_id}`;
    for (const m of members.filter((m) => m.held)) add({ symbol: sym(m), id: m.instrument_id, held: true, member: m });
    for (const m of members.filter((m) => !m.held)) add({ symbol: sym(m), id: m.instrument_id, held: false, member: m });
  } else {
    for (const s of watched.get(r.key) ?? []) add({ symbol: s, id: null, held: false });
  }
  return out;
}
/** The symbols of `topicMembers`. */
export const topicSymbols = (r: Pick<DisplayRow, "key" | "instruments" | "member_instruments">, symOf: SymOf, watched: Map<string, string[]>): string[] =>
  topicMembers(r, symOf, watched).map((m) => m.symbol);
/** `NVDA · SMH · AMD +2`: first `n` symbols, the rest as a count (P9 subtitle: every symbol, `n` = Infinity). */
export const symbolsText = (syms: string[], n = 3): string => syms.slice(0, n).join(" · ") + (syms.length > n ? ` +${syms.length - n}` : "");

/** P9: the brief lines under a topic: up to 3, newest first; only the first carries its `why`. */
export function briefLines(r: Pick<DisplayRow, "briefs">): { id: number; headline: string; why: string | null; date: string; unread: boolean }[] {
  return [...(r.briefs ?? [])].sort((a, b) => b.observed_at.localeCompare(a.observed_at)).slice(0, 3)
    .map((b, i) => ({ id: b.note_id, headline: b.headline, why: i === 0 ? b.why : null, date: b.observed_at ? dm(b.observed_at) : "", unread: b.unread }));
}

/** P9 topic thesis state: `draft` = an agent draft waiting for the owner's confirmation (`do potwierdzenia`). */
export const thesisDraft = (t: Pick<TopicThesis, "draft"> | null | undefined): boolean => !!t?.draft;

/** A cited view source as a small link: `publisher · d.mm.yyyy` (falls back to the title, then the host);
 * `href` only for an http(s) URL (the view comes from an agent; never a javascript: URL). */
export interface ViewSourceLink { href: string | null; text: string; title: string }
export function viewSourceLink(s: NoteSource): ViewSourceLink {
  let who = (s.publisher || s.title || "").trim();
  if (!who) { try { who = new URL(s.url).hostname.replace(/^www\./, ""); } catch { who = "źródło"; } }
  const p = s.published_at ? dateParts(s.published_at) : null;
  const href = /^https?:\/\//i.test(s.url ?? "") ? s.url : null;
  return { href, text: p ? `${who} · ${p.d}.${String(p.m).padStart(2, "0")}.${p.y}` : who, title: s.title || s.url || who };
}

/** P11 market view under a topic thesis (`Ocena teraz` / `Perspektywa`) with its cited sources; null when the
 * thesis has neither text. `publishers`: the distinct publishers for the home row tooltip (`Źródła: IFR, IEA`). */
export function topicView(t: TopicThesis | null | undefined): { assessment: string | null; outlook: string | null; at: string | null; sources: ViewSourceLink[]; publishers: string | null } | null {
  if (!t || (!t.assessment && !t.outlook)) return null;
  const list = t.view_sources ?? [];
  const names = [...new Set(list.map((s) => (s.publisher || s.title || "").trim()).filter(Boolean))];
  return {
    assessment: t.assessment ?? null, outlook: t.outlook ?? null, at: t.view_updated_at ?? null,
    sources: list.map(viewSourceLink), publishers: names.length ? `Źródła: ${names.join(", ")}` : null,
  };
}

/** P11 what one save of the thesis form writes: the thesis only when its text / invalidation changed (or there is
 * none yet: an owner save confirms an agent draft, so editing only the view must not confirm it), the view only
 * when it changed. Blank fields read as null. */
export function topicSavePlan(t: TopicThesis | null | undefined, e: { thesis: string; invalidation: string; assessment: string; outlook: string }): { thesis: boolean; view: boolean } {
  const n = (v: string | null | undefined) => (v ?? "").trim() || null;
  const thesis = !t || n(e.thesis) !== n(t.thesis) || n(e.invalidation) !== n(t.invalidation);
  const view = n(e.assessment) !== n(t?.assessment) || n(e.outlook) !== n(t?.outlook);
  return { thesis, view };
}

/** Two sub-columns from 6 rows (column-major: the first ceil(n/2) rows left); one column below. */
export const topicColumns = (n: number): { cols: 1 | 2; rows: number } => (n >= 6 ? { cols: 2, rows: Math.ceil(n / 2) } : { cols: 1, rows: n });

// ---- tolerant reading of the payload ----------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function normInstruments(v: unknown): SegmentInstrument[] {
  return arr(v).map((x) => {
    if (typeof x === "number" || typeof x === "string") return { instrument_id: Number(x), contribution: 0, return: null };
    const o = obj(x);
    return { instrument_id: Number(o.instrument_id ?? o.id), contribution: num(o.contribution) ?? 0, return: num(o.return), label: str(o.label) ?? str(o.symbol), weight: num(o.weight) };
  }).filter((i) => Number.isFinite(i.instrument_id));
}

function normMembers(v: unknown): SegmentMember[] {
  return arr(v).map((x) => {
    const o = obj(x);
    return { instrument_id: Number(o.instrument_id ?? o.id), label: str(o.label) ?? str(o.symbol), held: o.held === true, return_1w: num(o.return_1w), return_4w: num(o.return_4w) };
  }).filter((m) => Number.isFinite(m.instrument_id));
}

export function normNoteRef(v: unknown): SegmentNoteRef | null {
  const o = obj(v);
  const id = num(o.id);
  if (id == null || !str(o.title)) return null;
  return { id, title: String(o.title), observed_at: str(o.observed_at) ?? "", polarity: str(o.polarity), kind: str(o.kind) ?? undefined, strength: num(o.strength) };
}

export function normSegmentRow(v: unknown): SegmentRow | null {
  const o = obj(v);
  const raw = str(o.segment) ?? str(o.key);
  if (!raw) return null;
  const key = canonKey(raw)!;
  const cat = SEGMENTS.find((s) => s.key === key);
  // A renamed key from an older server carries its old label: the catalog label wins then.
  const label = raw !== key ? segmentLabel(key) : str(o.label) ?? segmentLabel(key);
  return {
    segment: key, label, group: (str(o.group) ?? cat?.group ?? "asset") as SegmentRow["group"],
    weight: num(o.weight) ?? 0, contribution: num(o.contribution) ?? 0, return: num(o.return),
    instruments: normInstruments(o.instruments), note: normNoteRef(o.note), note_this_week: o.note_this_week === true,
    unread: num(o.unread) ?? 0, notes_8w: num(o.notes_8w) ?? 0, last_note_at: str(o.last_note_at),
    trend_1w: num(o.trend_1w), trend_4w: num(o.trend_4w), members: num(o.members) ?? 0,
    ...(Array.isArray(o.member_instruments) ? { member_instruments: normMembers(o.member_instruments) } : {}),
    briefs: normTopicBriefs(o.briefs), thesis: normTopicThesis(o.thesis),
  };
}

/** P9 `briefs`: entries without a headline are dropped; newest first, at most 3. */
export function normTopicBriefs(v: unknown): TopicBrief[] {
  return arr(v).map((x): TopicBrief | null => {
    const o = obj(x);
    const d = obj(obj(o.details).brief);
    const headline = str(o.headline) ?? str(d.headline);
    const id = num(o.note_id) ?? num(o.id);
    if (!headline || id == null) return null;
    return { note_id: id, headline, why: str(o.why) ?? str(d.why), observed_at: str(o.observed_at) ?? "", kind: str(o.kind), polarity: str(o.polarity), unread: o.unread === true };
  }).filter((b): b is TopicBrief => !!b).sort((a, b) => b.observed_at.localeCompare(a.observed_at)).slice(0, 3);
}

/** P9 topic thesis (the segments row's `thesis`, the thesis endpoint's answer); null without a thesis text. */
export function normTopicThesis(v: unknown): TopicThesis | null {
  const o = obj(v);
  const text = str(o.thesis) ?? str(o.text);
  if (!text) return null;
  return {
    id: num(o.id), segment: str(o.segment), thesis: text, invalidation: str(o.invalidation), draft: o.draft === true, created_by: str(o.created_by) ?? "owner",
    assessment: str(o.assessment)?.trim() || null, outlook: str(o.outlook)?.trim() || null, view_updated_at: str(o.view_updated_at),
    view_sources: arr(o.view_sources).flatMap((v): NoteSource[] => {
      const x = obj(v); const url = str(x.url);
      return url ? [{ url, title: str(x.title), publisher: str(x.publisher), published_at: str(x.published_at) }] : [];
    }).slice(0, 6),
    core_changed_at: str(o.core_changed_at), created_at: str(o.created_at), updated_at: str(o.updated_at),
  };
}

/** The attribution with every field the UI relies on present (numbers, arrays, the catalog label fallback). */
export function normAttribution(v: unknown, window: SegmentWindow = "1w"): SegmentAttribution {
  const o = obj(v);
  const u = o.unassigned == null ? null : obj(o.unassigned);
  const c = obj(o.currency);
  const end = str(o.end) ?? str(o.as_of) ?? "";
  return {
    as_of: str(o.as_of) ?? end, start: str(o.start) ?? "", end, window: (str(o.window) as SegmentWindow) ?? window, base_currency: str(o.base_currency) ?? "PLN",
    portfolio_return: num(o.portfolio_return), explained: num(o.explained) ?? 0, residual: num(o.residual),
    new_positions: num(o.new_positions) ?? 0,
    stale: arr(o.stale).map((x) => (typeof x === "object" && x ? Number(obj(x).instrument_id ?? obj(x).id) : Number(x))).filter((x) => Number.isFinite(x)),
    segments: arr(o.segments).map(normSegmentRow).filter((x): x is SegmentRow => !!x),
    unassigned: u ? { weight: num(u.weight) ?? 0, contribution: num(u.contribution) ?? 0, return: num(u.return), instruments: normInstruments(u.instruments) } : null,
    currency: {
      contribution: num(c.contribution) ?? 0,
      currencies: arr(c.currencies).map((x) => { const q = obj(x); return { currency: str(q.currency) ?? "?", weight: num(q.weight) ?? 0, return: num(q.return) ?? 0, contribution: num(q.contribution) ?? 0 }; }),
    },
  };
}

/** The digest's `research.segments` + `research.market` read tolerantly (market null when absent). */
export function normDigestMarket(segments: unknown, market: unknown): { segments: SegmentRow[]; market: SegmentAttribution | null } {
  const rows = arr(segments).map(normSegmentRow).filter((x): x is SegmentRow => !!x);
  return { segments: rows, market: market && typeof market === "object" ? normAttribution({ ...(market as object), segments: [] }) : null };
}

/** The location hash with `?segment=<key>` set (or removed for null), other query params kept: the research page
 * writes its selection back with `history.replaceState`, so a reload keeps the filter (no history entries). */
export function hashWithSegment(hash: string, key: string | null): string {
  const i = hash.indexOf("?");
  const path = i < 0 ? hash : hash.slice(0, i);
  const q = new URLSearchParams(i < 0 ? "" : hash.slice(i + 1));
  if (key) q.set("segment", key);
  else q.delete("segment");
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
