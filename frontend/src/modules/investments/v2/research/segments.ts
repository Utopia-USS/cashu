// P5 market segments ("Rynek", design/P5/segments-design.md): the catalog (kept in sync with the BE
// `INV/research/segments.py`), the tolerant reading of `GET .../research/segments`, the contribution tone and
// text, the diverging bar geometry, the row selection of the home / review column and the page widget, the sub
// line and the tooltips. Pure; `npm test` imports it (imports carry .ts).
import { dm, pct, pctTarget, pp } from "../../labels.ts";
import type { SegmentAttribution, SegmentCurrency, SegmentInstrument, SegmentNoteRef, SegmentRow, SegmentWindow } from "./types.ts";

export type SegmentGroup = "asset" | "sector";

export const SEGMENTS: { key: string; label: string; group: SegmentGroup }[] = [
  { key: "equity_global", label: "Akcje globalne", group: "asset" }, { key: "equity_pl", label: "Akcje polskie", group: "asset" },
  { key: "equity_em", label: "Rynki wschodzące", group: "asset" }, { key: "bonds", label: "Obligacje i stopy", group: "asset" },
  { key: "gold", label: "Złoto i górnicy", group: "asset" }, { key: "energy", label: "Ropa i gaz", group: "asset" },
  { key: "uranium", label: "Uran i atom", group: "asset" }, { key: "metals", label: "Metale przemysłowe", group: "asset" },
  { key: "crypto", label: "Krypto", group: "asset" }, { key: "real_estate", label: "Nieruchomości", group: "asset" },
  { key: "semis_ai", label: "Półprzewodniki i AI", group: "sector" }, { key: "software", label: "Oprogramowanie i internet", group: "sector" },
  { key: "healthcare", label: "Ochrona zdrowia", group: "sector" }, { key: "financials", label: "Finanse i płatności", group: "sector" },
  { key: "consumer", label: "Konsumpcja", group: "sector" }, { key: "games_media", label: "Gry i media", group: "sector" },
  { key: "industrials", label: "Przemysł i obronność", group: "sector" }, { key: "quantum", label: "Komputery kwantowe", group: "sector" },
];
/** Pseudo key of the `Bez segmentu` row and of `?segment=unassigned`. */
export const UNASSIGNED = "unassigned";
/** Pseudo key of the `Waluty` row (no notes behind it). */
export const CURRENCY = "currency";
export const isSegment = (key: string | null | undefined): boolean => !!key && SEGMENTS.some((s) => s.key === key);
export const segmentLabel = (key: string | null | undefined): string =>
  key === UNASSIGNED ? "Bez segmentu" : SEGMENTS.find((s) => s.key === key)?.label ?? key ?? "";

/** Waluty is shown from 0,1 pp of the portfolio; Bez segmentu from 2 % weight. */
export const CURRENCY_MIN = 0.001;
export const UNASSIGNED_MIN = 0.02;

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

/** One rendered row: a catalog segment, `Waluty` or `Bez segmentu`. */
export interface DisplayRow {
  key: string;
  kind: "segment" | "currency" | "unassigned";
  label: string;
  weight: number;
  contribution: number;
  return: number | null;
  instruments: SegmentInstrument[];
  note: SegmentNoteRef | null;
  note_this_week: boolean;
  /** Newest stored note, expired included (fallback of `bez zmian od`). */
  last_note_at?: string | null;
  unread: number;
  currencies?: SegmentCurrency[];
}

export const segmentDisplay = (s: SegmentRow): DisplayRow => ({
  key: s.segment, kind: "segment", label: s.label || segmentLabel(s.segment), weight: s.weight, contribution: s.contribution, return: s.return,
  instruments: s.instruments, note: s.note, note_this_week: s.note_this_week, last_note_at: s.last_note_at ?? null, unread: s.unread,
});

/** The fixed rows that pass their thresholds: Waluty (|currency| >= 0,1 pp), Bez segmentu (weight >= 2 %). */
export function fixedRows(d: Pick<SegmentAttribution, "currency" | "unassigned">, opts: { forceUnassigned?: boolean } = {}): DisplayRow[] {
  const out: DisplayRow[] = [];
  if (d.currency && Math.abs(d.currency.contribution) >= CURRENCY_MIN) {
    out.push({ key: CURRENCY, kind: "currency", label: "Waluty", weight: 0, contribution: d.currency.contribution, return: null, instruments: [], note: null, note_this_week: false, unread: 0, currencies: d.currency.currencies });
  }
  const u = d.unassigned;
  if (u && (u.weight >= UNASSIGNED_MIN || (opts.forceUnassigned && u.weight > 0))) {
    // An older payload without `return`: contribution / weight is the V0-weighted local return.
    const ret = u.return ?? (u.weight > 0 ? u.contribution / u.weight : null);
    out.push({ key: UNASSIGNED, kind: "unassigned", label: "Bez segmentu", weight: u.weight, contribution: u.contribution, return: ret, instruments: u.instruments, note: null, note_this_week: false, unread: 0 });
  }
  return out;
}

/** Home column (6 rows): fixed rows that pass their thresholds take their slots, segments in payload order (the
 * BE sorts by |contribution|, ties by catalog) take the rest; output order segments, Waluty, Bez segmentu.
 * `rest` = the dropped segments (count and their unread notes). */
export function homeRows(d: Pick<SegmentAttribution, "segments" | "currency" | "unassigned">, max = 6): { rows: DisplayRow[]; rest: { count: number; unread: number } } {
  const fixed = fixedRows(d);
  const slots = Math.max(0, max - fixed.length);
  const shown = d.segments.slice(0, slots);
  const dropped = d.segments.slice(slots);
  return { rows: [...shown.map(segmentDisplay), ...fixed], rest: { count: dropped.length, unread: dropped.reduce((s, x) => s + (x.unread || 0), 0) } };
}

/** Page widget: every segment, then Waluty and Bez segmentu when they pass their thresholds. */
export const pageRows = (d: Pick<SegmentAttribution, "segments" | "currency" | "unassigned">): DisplayRow[] => [...d.segments.map(segmentDisplay), ...fixedRows(d)];

/** Review column: rows with a new note first, then the rest in payload order (the digest sends at most 6). */
export const reviewRows = (segments: SegmentRow[]): DisplayRow[] =>
  [...segments.filter((s) => s.note_this_week), ...segments.filter((s) => !s.note_this_week)].map(segmentDisplay);

/** Review column (6 rows like home): the digest's segments (new notes first) then Waluty and Bez segmentu from the
 * digest's `market` block when they pass their thresholds. */
export function reviewColumn(segments: SegmentRow[], market: Pick<SegmentAttribution, "currency" | "unassigned"> | null | undefined, max = 6): DisplayRow[] {
  const fixed = market ? fixedRows(market) : [];
  return [...reviewRows(segments).slice(0, Math.max(0, max - fixed.length)), ...fixed];
}

/** A note-only segment (no exposure at the window start): `-` instead of `0,0 pp`, no bar. A held non-market
 * segment (weight > 0, contribution 0) keeps `0,0 pp`. */
export const noExposure = (r: Pick<DisplayRow, "kind" | "weight">): boolean => r.kind === "segment" && !(r.weight > 0);

/** Segments with held exposure at the window start (the `Rynek · N` count). */
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

/** Sub line of a row: the note title this week, `bez zmian od d.m` for an older note, otherwise the first three
 * symbols; Waluty: the top two currencies. `title` = the full text (the line ellipsizes). */
export function segmentSub(r: DisplayRow, symOf: SymOf): { text: string; title: string } {
  let text: string;
  if (r.kind === "currency") text = currencySub(r.currencies);
  else if (r.note && r.note_this_week) text = r.note.title;
  else if (r.note) text = `bez zmian od ${dm(r.note.observed_at)}`;
  else if (r.last_note_at) text = `bez zmian od ${dm(r.last_note_at)}`;
  else text = symbolsOf(r.instruments, symOf).slice(0, 3).join(" · ");
  return { text, title: r.note && r.note_this_week ? r.note.title : text };
}

/** Symbols of a row's instruments with a stale price; a row is marked when any is stale. */
export const staleSymbols = (r: Pick<DisplayRow, "instruments">, stale: number[], symOf: SymOf): string[] =>
  r.instruments.filter((i) => stale.includes(i.instrument_id)).map((i) => instSymbol(i, symOf));
export const staleTitle = (syms: string[]) => (syms.length ? `notowania nieaktualne: ${syms.join(", ")}` : undefined);

/** Home header tooltip: `1.10 - 8.10 · TWR portfela` (+ `· brak pełnej historii` without the portfolio move). */
export const windowTitle = (d: Pick<SegmentAttribution, "start" | "end" | "portfolio_return">) =>
  `${dm(d.start)} - ${dm(d.end)} · TWR portfela${d.portfolio_return == null ? " · brak pełnej historii" : ""}`;

/** Page fact tooltip: `wyjaśnione -1,2 % · reszta -0,1 % · 1.10 - 8.10 · 1 nowa pozycja poza oknem · nieaktualne: GDXJ`. */
export function factTitle(d: Pick<SegmentAttribution, "explained" | "residual" | "start" | "end" | "new_positions">, staleSyms: string[] = []): string {
  const parts = [`wyjaśnione ${pct(d.explained, true)}`, `reszta ${d.residual != null ? pct(d.residual, true) : "-"}`, `${dm(d.start)} - ${dm(d.end)}`];
  if (d.new_positions > 0) parts.push(`${nPositions(d.new_positions)} poza oknem`);
  if (staleSyms.length) parts.push(`nieaktualne: ${staleSyms.join(", ")}`);
  return parts.join(" · ");
}
function nPositions(n: number): string {
  const n10 = n % 10, n100 = n % 100;
  return `${n} ${n === 1 ? "nowa pozycja" : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? "nowe pozycje" : "nowych pozycji"}`;
}

/** Waluty chips on the page: `USD 55 %` (weight, whole percent when exact), max 3. */
export const currencyChips = (currencies: SegmentCurrency[] | undefined): string[] =>
  [...(currencies ?? [])].sort((a, b) => b.weight - a.weight).slice(0, 3).map((c) => `${c.currency} ${pctTarget(c.weight)}`);

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

function normNoteRef(v: unknown): SegmentNoteRef | null {
  const o = obj(v);
  const id = num(o.id);
  if (id == null || !str(o.title)) return null;
  return { id, title: String(o.title), observed_at: str(o.observed_at) ?? "", polarity: str(o.polarity), kind: str(o.kind) ?? undefined, strength: num(o.strength) };
}

export function normSegmentRow(v: unknown): SegmentRow | null {
  const o = obj(v);
  const key = str(o.segment) ?? str(o.key);
  if (!key) return null;
  const cat = SEGMENTS.find((s) => s.key === key);
  return {
    segment: key, label: str(o.label) ?? segmentLabel(key), group: (str(o.group) ?? cat?.group ?? "asset") as SegmentRow["group"],
    weight: num(o.weight) ?? 0, contribution: num(o.contribution) ?? 0, return: num(o.return),
    instruments: normInstruments(o.instruments), note: normNoteRef(o.note), note_this_week: o.note_this_week === true,
    unread: num(o.unread) ?? 0, notes_8w: num(o.notes_8w) ?? 0, last_note_at: str(o.last_note_at),
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
