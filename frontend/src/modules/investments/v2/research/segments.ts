// P5 market segments, P7 "Tematy" (design/P5/segments-design.md, design/P7/strip-design.md): the catalog (kept in sync with the BE
// `INV/research/segments.py`), the tolerant reading of `GET .../research/segments`, the contribution tone and
// text, the diverging bar geometry, the row selection of the home / review column and the page widget, the sub
// line and the tooltips. Pure; `npm test` imports it (imports carry .ts).
import { dm, pct, plural, pp } from "../../labels.ts";
import type { SegmentAttribution, SegmentCurrency, SegmentInstrument, SegmentMember, SegmentNoteRef, SegmentRow, SegmentWindow } from "./types.ts";

export type SegmentGroup = "asset" | "sector";

export const SEGMENTS: { key: string; label: string; group: SegmentGroup }[] = [
  { key: "equity_global", label: "Akcje globalne", group: "asset" }, { key: "equity_pl", label: "Akcje polskie", group: "asset" },
  { key: "equity_em", label: "Rynki wschodzące", group: "asset" }, { key: "bonds", label: "Obligacje i stopy", group: "asset" },
  { key: "gold", label: "Złoto i górnicy", group: "asset" }, { key: "energy", label: "Ropa i gaz", group: "asset" },
  { key: "power", label: "Energetyka: atom i OZE", group: "asset" }, { key: "metals", label: "Metale i ziemie rzadkie", group: "asset" },
  { key: "crypto", label: "Krypto", group: "asset" }, { key: "real_estate", label: "Nieruchomości", group: "asset" },
  { key: "semis_ai", label: "AI: chipy i centra danych", group: "sector" }, { key: "software", label: "AI i oprogramowanie", group: "sector" },
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
}

export const segmentDisplay = (s: SegmentRow): DisplayRow => ({
  key: s.segment, kind: "segment", label: s.label || segmentLabel(s.segment), weight: s.weight, contribution: s.contribution, return: s.return,
  instruments: s.instruments, note: s.note, note_this_week: s.note_this_week, last_note_at: s.last_note_at ?? null, unread: s.unread,
  trend_1w: s.trend_1w ?? null, trend_4w: s.trend_4w ?? null, members: s.members ?? 0,
  ...(s.member_instruments ? { member_instruments: s.member_instruments } : {}),
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

/** Top currencies by |contribution|: `USD -0,7 % · EUR +0,2 %`. */
export const currencySub = (currencies: SegmentCurrency[] | undefined, n = 2): string =>
  [...(currencies ?? [])].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, n).map((c) => `${c.currency} ${pct(c.return, true)}`).join(" · ");

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

/** Page fact tooltip: `wyjaśnione -1,2 % · reszta 0,0 % · 1.10 - 8.10 · 1 nowa pozycja poza oknem · nieaktualne: GDXJ`;
 * from |residual| >= 0,1 pp the residual moves to its own line (`residualLine`) instead of the inline `reszta`. */
export function factTitle(d: Pick<SegmentAttribution, "explained" | "residual" | "start" | "end" | "new_positions">, staleSyms: string[] = []): string {
  const line = residualLine(d);
  const parts = [`wyjaśnione ${pct(d.explained, true)}`];
  if (!line) parts.push(`reszta ${d.residual != null ? pct(d.residual, true) : "-"}`);
  parts.push(`${dm(d.start)} - ${dm(d.end)}`);
  if (d.new_positions > 0) parts.push(`${nPositions(d.new_positions)} poza oknem`);
  if (staleSyms.length) parts.push(`nieaktualne: ${staleSyms.join(", ")}`);
  return [parts.join(" · "), line].filter(Boolean).join("\n");
}
function nPositions(n: number): string {
  const n10 = n % 10, n100 = n % 100;
  return `${n} ${n === 1 ? "nowa pozycja" : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? "nowe pozycje" : "nowych pozycji"}`;
}

// ---- topics (P7 design 1.3) --------------------------------------------------------------------------------

export type TopicKind = "held" | "new" | "watched" | "none";
/** A member of the row is held now (BE `member_instruments`, held at the window end). */
export const heldNow = (r: Pick<DisplayRow, "member_instruments">): boolean => !!r.member_instruments?.some((m) => m.held);

/** held = exposure at the window start; new = no exposure at the start but a member held now (bought inside the window:
 * not muted, not `tylko obserwowane`, no contribution); watched = priced members, none held; none = a note-only row. */
export const topicKind = (r: Pick<DisplayRow, "weight" | "members" | "member_instruments">): TopicKind =>
  r.weight > 0 ? "held" : heldNow(r) ? "new" : (r.members ?? 0) > 0 ? "watched" : "none";
const KIND_RANK: Record<TopicKind, number> = { held: 0, new: 1, watched: 2, none: 3 };

/** Home column: held topics in payload order (BE: |contribution| desc), then new and watched-only (BE: |trend_1w|
 * desc), max 10. No Waluty, no unassigned, no note-only rows. `rest` = dropped topics. */
export function homeTopics(d: Pick<SegmentAttribution, "segments">, max = 10): { rows: DisplayRow[]; rest: number } {
  const all = d.segments.map(segmentDisplay).filter((r) => topicKind(r) !== "none");
  const shown = all.sort((a, b) => KIND_RANK[topicKind(a)] - KIND_RANK[topicKind(b)]);
  const rows = shown.slice(0, max);
  return { rows, rest: shown.length - rows.length };
}
/** Review column: rows with a new note first, then the rest; held, new, watched inside each group; max 6; no fixed rows. */
export function reviewTopics(segments: SegmentRow[], max = 6): DisplayRow[] {
  const rows = segments.map(segmentDisplay).filter((r) => topicKind(r) !== "none");
  const rank = (r: DisplayRow) => (r.note_this_week ? 0 : 3) + KIND_RANK[topicKind(r)];
  return rows.sort((a, b) => rank(a) - rank(b)).slice(0, max);
}
/** Page widget: held, new, watched-only, then note-only rows (muted `-` rows); never Waluty or the unassigned bucket as rows. */
export const pageTopics = (d: Pick<SegmentAttribution, "segments">): DisplayRow[] =>
  d.segments.map(segmentDisplay).sort((a, b) => KIND_RANK[topicKind(a)] - KIND_RANK[topicKind(b)]);
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
/** `NVDA · SMH · AMD +2`: first `n` symbols, the rest as a count. */
export const symbolsText = (syms: string[], n = 3): string => syms.slice(0, n).join(" · ") + (syms.length > n ? ` +${syms.length - n}` : "");

/** Second line of a topic row: this week's note title (fresh), else the small date of the last note, else nothing.
 * No `bez zmian` anywhere. */
export function topicNote(r: Pick<DisplayRow, "note" | "note_this_week" | "last_note_at">): { text: string; title: string; fresh: boolean } | null {
  if (r.note && r.note_this_week) return { text: r.note.title, title: r.note.title, fresh: true };
  const at = r.note?.observed_at || r.last_note_at;
  return at ? { text: dm(at), title: `ostatnia notatka ${dm(at)}`, fresh: false } : null;
}

/** The trend of a window. */
export const trendOf = (r: Pick<DisplayRow, "trend_1w" | "trend_4w">, window: SegmentWindow): number | null => (window === "4w" ? r.trend_4w ?? null : r.trend_1w ?? null);
/** `+3,1 %` / `-`. */
export const trendText = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? "-" : pct(v, true));
/** Trend cell tooltip: `3 instrumenty, równe wagi · 4 tyg. +8,2 %` (home) or `… · ważona udziałem -4,4 %` (page). */
export function trendTitle(r: Pick<DisplayRow, "members" | "trend_4w" | "return" | "weight">, opts: { page?: boolean } = {}): string {
  const parts = [`${plural(r.members ?? 0, "instrument", "instrumenty", "instrumentów")}, równe wagi`];
  if (!opts.page && r.trend_4w != null) parts.push(`4 tyg. ${pct(r.trend_4w, true)}`);
  if (opts.page && r.weight > 0 && r.return != null) parts.push(`ważona udziałem ${pct(r.return, true)}`);
  return parts.join(" · ");
}

/** Two sub-columns from 6 rows (column-major: the first ceil(n/2) rows left); one column below. */
export const topicColumns = (n: number): { cols: 1 | 2; rows: number } => (n >= 6 ? { cols: 2, rows: Math.ceil(n / 2) } : { cols: 1, rows: n });

/** Page footer line (muted): `waluty +0,6 pp · USD +0,6 % · EUR +0,1 %`; null without currencies. */
export function currencyFoot(d: Pick<SegmentAttribution, "currency">): { pp: string; tone: PpTone; detail: string } | null {
  if (!d.currency?.currencies.length) return null;
  return { pp: ppOf(d.currency.contribution), tone: ppTone(d.currency.contribution), detail: currencySub(d.currency.currencies) };
}

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
