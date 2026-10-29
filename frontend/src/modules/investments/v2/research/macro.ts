// P6 macro regimes ("Makro", design/P6/macro-design.md; P7 strip-design.md 1.4): the catalog (kept in sync with
// the BE `INV/macro/regimes.py`), the state words, the summary / explain texts of the home rows, the tooltips, the ordering and the tolerant
// reading of `GET .../research/macro` and the digest's `macro_changes`. Pure; `npm test` imports it (imports
// carry .ts). segments.ts never imports this file (no cycle).
import { dm } from "../../labels.ts";
import { MONTH_GEN } from "../../../../format.ts";
import { normNoteRef, segmentLabel } from "./segments.ts";
import type { MacroBrief, MacroChange, MacroHistoryItem, MacroKey, MacroMetric, MacroRegime, MacroRegimes } from "./types.ts";

export const MACRO_PREFIX = "macro_";
export const MACRO: { key: MacroKey; label: string; noteKey: string; subject: string }[] = [
  { key: "risk", label: "Rynek akcji", noteKey: "macro_risk", subject: "akcje" },
  { key: "dollar", label: "Dolar", noteKey: "macro_dollar", subject: "dolar" },
  { key: "em", label: "Rynki wschodzące", noteKey: "macro_em", subject: "EM" },
  { key: "commodities", label: "Surowce", noteKey: "macro_commodities", subject: "surowce" },
  { key: "rates", label: "Obligacje i stopy", noteKey: "macro_rates", subject: "stopy" },
];
export const MACRO_KEYS: MacroKey[] = MACRO.map((m) => m.key);
export const macroNoteKey = (key: string): string => `${MACRO_PREFIX}${key}`;
/** `macro_rates` -> `rates`; null for anything else. */
export const macroKeyOf = (noteKey: string | null | undefined): MacroKey | null => MACRO.find((m) => m.noteKey === noteKey)?.key ?? null;
export const isMacroKey = (noteKey: string | null | undefined): boolean => macroKeyOf(noteKey) != null;
/** Title of a macro note key: `Obligacje i stopy`; the key itself when unknown. */
export const macroLabel = (noteKey: string | null | undefined): string => MACRO.find((m) => m.noteKey === noteKey)?.label ?? noteKey ?? "";
/** Label of any note key (chip, note card): `Makro · Obligacje i stopy` for a macro key (two P6 titles collide
 * with P5 segment titles: `Rynki wschodzące`, `Obligacje i stopy`), else the P5 segment label. */
export const noteKeyLabel = (key: string | null | undefined): string => (isMacroKey(key) ? `Makro · ${macroLabel(key)}` : segmentLabel(key));

/** Polish label per machine state (the BE's `state_label` words, kept in sync with regimes.py): used for past
 * states in the history tooltip and as the fallback when a payload lacks `state_label`. */
export const STATE_LABEL: Record<MacroKey, Record<string, string>> = {
  risk: { bull: "hossa", bear: "bessa", correction: "korekta", weak: "słabość", flat: "bez trendu", unknown: "brak danych" },
  dollar: { strong: "umacnia się", weak: "słabnie", flat: "bez trendu", unknown: "brak danych" },
  em: { leading: "silniejsze od świata", lagging: "słabsze od świata", inline: "w linii", unknown: "brak danych" },
  commodities: { bull: "hossa surowcowa", bear: "bessa surowcowa", flat: "bez trendu", unknown: "brak danych" },
  rates: { rising: "rentowności rosną", falling: "rentowności spadają", stable: "rentowności stabilne", unknown: "brak danych" },
};
export const stateLabel = (key: string, state: string, fallback = state): string => (STATE_LABEL as Record<string, Record<string, string>>)[key]?.[state] ?? fallback;

export const INVERTED = "krzywa odwrócona";
/** `rentowności rosną · krzywa odwrócona` -> ["rentowności rosną", "krzywa odwrócona"]; one part otherwise. */
export const stateParts = (label: string): string[] => label.split(" · ").map((s) => s.trim()).filter(Boolean);
export const isInverted = (r: Pick<MacroRegime, "state_label">): boolean => stateParts(r.state_label).slice(1).some((p) => p.toLowerCase() === INVERTED);

/** Tone -> class; anything unexpected is no tone. */
export const toneCls = (tone: string | null | undefined): "pos" | "neg" | "warn" | "" => (tone === "pos" || tone === "neg" || tone === "warn" ? tone : "");

const yearOf = (iso: string | null | undefined): string | null => (iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : null);
/** `14.08`, or `21.08.2025` when the year differs from the reference date's year (the regime's last bar). */
export const dateText = (iso: string, ref?: string | null): string => {
  const y = yearOf(iso), ry = yearOf(ref);
  return y && ry && y !== ry ? `${dm(iso)}.${y}` : dm(iso);
};
/** `21.08.2025`: always with the year. */
const dmYear = (iso: string): string => (yearOf(iso) ? `${dm(iso)}.${yearOf(iso)}` : dm(iso));

/** Whole months from `from` to `to` (calendar dates). */
export function monthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.slice(0, 10).split("-").map(Number), [y2, m2, d2] = to.slice(0, 10).split("-").map(Number);
  if (![y1, m1, d1, y2, m2, d2].every(Number.isFinite)) return 0;
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}
/** An open-ended state (held since before the data window), one rule: under a year `ponad N mies.`
 * (`ponad miesiąca` for 1), 12-23 months `ponad roku`, from 24 months `ponad N lat`; null under a month. */
export function openSpan(from: string, to: string): string | null {
  const n = monthsBetween(from, to);
  if (n >= 24) return `ponad ${Math.floor(n / 12)} lat`;
  if (n >= 12) return "ponad roku";
  if (n >= 2) return `ponad ${n} mies.`;
  return n === 1 ? "ponad miesiąca" : null;
}

type SinceLike = Pick<MacroRegime, "since" | "missing"> & Partial<Pick<MacroRegime, "since_open" | "since_min" | "as_of">>;
/** `od 14.08` (`od 21.08.2025` from another year); an open-ended state `od ponad roku` (from `since_min` to the last
 * bar); null without a date or when missing. */
export function sinceText(r: SinceLike): string | null {
  if (r.missing) return null;
  if (r.since_open) {
    if (!r.since_min) return null;
    const span = r.as_of ? openSpan(r.since_min, r.as_of) : null;
    return span ? `od ${span}` : `od ${dateText(r.since_min, r.as_of)}`;
  }
  return r.since ? `od ${dateText(r.since, r.as_of)}` : null;
}
/** `dane z 3.10` when stale (as_of = last bar used); null otherwise. */
export const staleText = (r: Pick<MacroRegime, "stale" | "as_of" | "missing">): string | null => (r.stale && !r.missing && r.as_of ? `dane z ${dm(r.as_of)}` : null);

/** History tooltip on the `od d.mm` text: the current state first, then the previous changes, newest first,
 * at most 5 lines. The history's last item is the current state's start when its date equals `since`; it is
 * not repeated. Null when there is nothing before the current state (the tooltip then is not set). */
export function historyTitle(r: Pick<MacroRegime, "key" | "since" | "state_label" | "history" | "missing"> & Partial<Pick<MacroRegime, "since_open" | "since_min" | "as_of">>, max = 5): string | null {
  if (r.missing) return null;
  // The current run is not repeated: its start equals `since`, or (open-ended) it is the window's open first run.
  const current = (h: MacroHistoryItem) => h.date === r.since || (!!r.since_open && (h.open === true || h.date === r.since_min));
  const past = [...(r.history ?? [])].filter((h) => !current(h)).reverse();
  if (!past.length) return null;
  const head = stateParts(r.state_label)[0] ?? "";
  const since = sinceText(r);
  const line = (h: MacroHistoryItem) => `${h.open ? `przed ${dmYear(h.date)}` : `od ${dateText(h.date, r.as_of)}`} ${stateLabel(r.key, h.state, h.state_label ?? h.state)}`;
  return [since ? `${since} ${head}` : head, ...past.map(line)].slice(0, max).join("\n");
}

/** A stale metric's note: `dane z 3.10` when the metric carries its date, else `nieaktualne`. */
export const metricStale = (m: Pick<MacroMetric, "as_of">): string => (m.as_of ? `dane z ${dm(m.as_of)}` : "nieaktualne");
/** Metric row tooltip: the stale note for a stale metric, else the BE `change_label` (if any). */
export const metricTitle = (m: Pick<MacroMetric, "stale" | "as_of" | "change_label">): string | undefined => (m.stale ? metricStale(m) : m.change_label ?? undefined);

/** Date of the `stan d.mm` tag: the payload's last bar date, else the newest regime `as_of`; null when none. */
export function macroAsOf(d: Pick<MacroRegimes, "as_of" | "regimes"> | null | undefined): string | null {
  if (!d) return null;
  if (d.as_of) return d.as_of;
  const dates = d.regimes.map((r) => r.as_of).filter((x): x is string => !!x).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

// ---- P7 home rows: the one on-screen sentence and the explain popover ----------------------------------------

/** The one on-screen sentence: BE `summary`; older server: `meaning`; neither: the metrics joined (`DXY 98,4 · 6 mies. -4,8 %`). */
export function summaryText(r: Pick<MacroRegime, "summary" | "meaning" | "metrics" | "missing">): string {
  if (r.missing) return "Brak danych.";
  return r.summary ?? r.meaning ?? r.metrics.map((m) => `${m.label} ${m.text}`).join(" · ");
}
/** The popover exists when there is something longer than the summary to show. */
export const hasExplain = (r: Pick<MacroRegime, "explain" | "meaning" | "summary" | "missing">): boolean => !r.missing && !!(r.explain ?? (r.summary ? r.meaning : null));
/** Popover body text: `explain`, else `meaning` (when the summary is on screen already). */
export const explainText = (r: Pick<MacroRegime, "explain" | "meaning" | "summary">): string | null => r.explain ?? (r.summary ? r.meaning : null);
/** Popover head: `Dolar · słabnie · od 2.10` (+ ` · dane z 26.09` when stale). */
export function explainHead(r: Pick<MacroRegime, "label" | "state_label" | "since" | "missing" | "stale" | "as_of"> & Partial<Pick<MacroRegime, "since_open" | "since_min">>): string {
  return [r.label, stateParts(r.state_label)[0], sinceText(r), staleText(r)].filter(Boolean).join(" · ");
}

// ---- P9 home rows: the brief "for dummies" -----------------------------------------------------------------

/** `sierpnia 2026` (genitive month + year); null for a bad date. */
export function monthYear(iso: string | null | undefined): string | null {
  const m = iso ? /^(\d{4})-(\d{2})/.exec(iso) : null;
  const i = m ? Number(m[2]) - 1 : -1;
  return m && i >= 0 && i < 12 ? `${MONTH_GEN[i]} ${m[1]}` : null;
}
/** The row's since text: `od sierpnia 2026`; an open-ended state `od ponad roku` (from `since_min` to the last bar), or
 * `od <month year of since_min>` when the span is under a month; null without a date or when missing. */
export function sinceMonth(r: SinceLike): string | null {
  if (r.missing) return null;
  if (r.since_open) {
    if (!r.since_min) return null;
    const span = r.as_of ? openSpan(r.since_min, r.as_of) : null;
    const my = monthYear(r.since_min);
    return span ? `od ${span}` : my ? `od ${my}` : null;
  }
  const my = monthYear(r.since);
  return my ? `od ${my}` : null;
}
/** The bold line: the brief's headline, else the BE's plain sentence, else (older server) the P7 summary. */
export function macroHeadline(r: Pick<MacroRegime, "summary" | "meaning" | "metrics" | "missing"> & Partial<Pick<MacroRegime, "brief" | "plain">>): string {
  if (r.missing) return "Brak danych.";
  return r.brief?.headline ?? r.plain ?? summaryText(r);
}
/** The one basic number next to the state: the first change metric (unit `pct`), its label as the tooltip. */
export function macroNumber(r: Pick<MacroRegime, "metrics" | "missing">): { text: string; title: string } | null {
  if (r.missing) return null;
  const m = r.metrics.find((x) => x.unit === "pct" && x.text && x.text !== "-");
  return m ? { text: m.text, title: m.stale ? `${m.label} · ${metricStale(m)}` : m.label } : null;
}

/** Catalog order regardless of payload order; unknown keys at the end in payload order. */
export const orderRegimes = (list: MacroRegime[]): MacroRegime[] => {
  const rank = (k: string) => { const i = MACRO_KEYS.indexOf(k as MacroKey); return i < 0 ? 99 : i; };
  return [...list].sort((a, b) => rank(a.key) - rank(b.key));
};

/** Review line labels: the inversion flag (a modifier) never goes into a change line. */
export const changeWord = (label: string): string => stateParts(label)[0] ?? label;

// ---- tolerant reading of the payload (same helpers as segments.ts) ----------------------------------------

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** P9 `brief`: null without a headline; `supports` / `risks` at most 3 strings each. */
export function normMacroBrief(v: unknown): MacroBrief | null {
  const o = obj(v);
  const d = obj(obj(o.details).brief);
  const headline = str(o.headline) ?? str(d.headline);
  const id = num(o.note_id) ?? num(o.id);
  if (!headline || id == null) return null;
  const list = (x: unknown) => arr(x).filter((s): s is string => typeof s === "string" && !!s.trim()).slice(0, 3);
  return {
    note_id: id, headline, why: str(o.why) ?? str(d.why), supports: list(o.supports ?? d.supports), risks: list(o.risks ?? d.risks),
    observed_at: str(o.observed_at) ?? "", unread: o.unread === true,
  };
}

export function normRegime(v: unknown): MacroRegime | null {
  const o = obj(v);
  const key = str(o.key);
  if (!key) return null;
  const cat = MACRO.find((m) => m.key === key);
  const state = str(o.state) ?? "unknown";
  const missing = o.missing === true || state === "unknown";
  let label = str(o.state_label) ?? stateLabel(key, state);
  // BE extra `flags: ["inverted"]`: the label carries the inversion as the second part (design 2.2).
  if (!missing && arr(o.flags).includes("inverted") && !isInverted({ state_label: label })) label = `${label} · ${INVERTED}`;
  const metrics: MacroMetric[] = arr(o.metrics).map((x) => {
    const m = obj(x);
    return { label: str(m.label) ?? "", value: num(m.value), unit: str(m.unit) ?? "level", text: str(m.text) ?? "-", change_label: str(m.change_label), stale: m.stale === true, as_of: str(m.as_of) ?? str(m.date) };
  }).filter((m) => m.label);
  const history: MacroHistoryItem[] = arr(o.history).map((x) => {
    const h = obj(x);
    return { date: str(h.date) ?? "", state: str(h.state) ?? "", state_label: str(h.state_label), open: h.open === true };
  }).filter((h) => h.date && h.state);
  return {
    key, label: str(o.label) ?? cat?.label ?? key, state, state_label: label, tone: toneCls(str(o.tone)),
    since: str(o.since), as_of: str(o.as_of), stale: !missing && o.stale === true, missing, meaning: str(o.meaning),
    summary: str(o.summary), explain: str(o.explain),
    since_open: !missing && o.since_open === true, since_min: str(o.since_min),
    metrics, history,
    note: normNoteRef(o.note), last_note_at: str(o.last_note_at), note_this_week: o.note_this_week === true, unread: num(o.unread) ?? 0,
    brief: missing ? null : normMacroBrief(o.brief), plain: str(o.plain),
  };
}

export function normMacro(v: unknown): MacroRegimes {
  const o = obj(v);
  return { as_of: str(o.as_of), regimes: orderRegimes(arr(o.regimes).map(normRegime).filter((x): x is MacroRegime => !!x)) };
}

export const normMacroChanges = (v: unknown): MacroChange[] => arr(v).map((x) => {
  const c = obj(x);
  const key = str(c.key) ?? "";
  return { key, label: str(c.label) ?? macroLabel(macroNoteKey(key)), from_label: changeWord(str(c.from_label) ?? ""), to_label: changeWord(str(c.to_label) ?? ""), since: str(c.since) ?? "" };
}).filter((c) => c.key && c.to_label);
