// Research layer logic without React (design/v2/research/research.md 3-8): copy deck maps, note dates and
// freshness, the 8-week sentiment score and its bars, the theme direction word, thesis health per position,
// candidate criteria, research signal copy, run state tags, the commands the UI copies, and where the strip
// sits in the home grid. Pure; `npm test` imports it (node strips the types; imports carry .ts).
import { dm, ENTRY_TYPE, plural, wdm } from "../../labels.ts";
import { hmLocal, localDay, parseServerTime } from "../../../../time.ts";
import type {
  Criterion, Direction, HealthKey, InstrumentSummary, NoteSource, Relation, RelationCounts, ResearchNote, ResearchRun,
} from "./types.ts";

// ---- copy deck (research.md 8) --------------------------------------------------------------------------

export const KIND_LABEL: Record<string, string> = {
  news: "wiadomość", earnings: "wyniki", community: "społeczność · szum", trend: "trend", macro: "makro", candidate: "kandydat",
};
/** Kind filter of the research view (plural forms). */
export const KIND_FILTER: [string, string][] = [["wiadomości", "news"], ["wyniki", "earnings"], ["społeczność", "community"], ["trendy", "trend"], ["makro", "macro"]];

export const POLARITY_WORD: Record<string, string> = { positive: "pozytywna", negative: "negatywna", neutral: "neutralna" };
export const POLARITY_CLS: Record<string, string> = { positive: "pos", negative: "neg", neutral: "neu" };
export const polarityCls = (p: string | null | undefined) => POLARITY_CLS[p ?? ""] ?? "neu";

export const STRENGTH_WORD = ["", "słaba", "umiarkowana", "silna"];
export const strengthTitle = (v: number) => `siła ${clampStrength(v)} z 3 (${STRENGTH_WORD[clampStrength(v)]})`;
export const clampStrength = (v: number) => Math.max(1, Math.min(3, Math.round(Number(v) || 1)));

export const RELATION_LABEL: Record<Relation, string> = {
  supports: "wzmacnia tezę", weakens: "osłabia tezę", invalidates: "podważa tezę", neutral: "nie dotyka tezy", none: "bez tezy",
};
export const RELATION_CLS: Record<Relation, string> = { supports: "sup", weakens: "weak", invalidates: "inv", neutral: "", none: "none" };

export const HEALTH_LABEL: Record<HealthKey, string> = {
  inv: "podważona", weak: "osłabiona", sup: "wzmocniona", ok: "aktualna", no_thesis: "bez tezy", no_research: "bez researchu",
};
export const HEALTH_CLS: Record<HealthKey, string> = { inv: "inv", weak: "weak", sup: "sup", ok: "", no_thesis: "none", no_research: "none muted" };
/** Attention order for lists (RS CONTRACT 1): invalidated, weakened, no_research, no_thesis, supported, current. */
export const HEALTH_RANK: Record<HealthKey, number> = { inv: 0, weak: 1, no_research: 2, no_thesis: 3, sup: 4, ok: 5 };

export const DIRECTION_LABEL: Record<Direction, string> = { up: "rośnie", down: "słabnie", flat: "stabilnie" };
export const DIRECTION_TONE: Record<Direction, "pos" | "neg" | ""> = { up: "pos", down: "neg", flat: "" };

export const THESIS_FIELD_LABEL: Record<string, string> = {
  entry_type: "Typ wejścia", thesis: "Wejście", invalidation: "Unieważnienie", exit_plan: "Plan wyjścia", size_plan: "Wielkość i dokupienia",
};
/** Loose field names (entry, exit, size) to the thesis record's field names. */
export const normField = (f: string | null | undefined): string | null =>
  !f ? null : ({ entry: "thesis", exit: "exit_plan", size: "size_plan", type: "entry_type" } as Record<string, string>)[f] ?? f;

export const BOUNDARY = "bez rekomendacji i prognoz";
export const RESEARCH_SKILL = "/market-research";
/** Prompt of the Saturday routine (the skill reads `rutyna` as a scheduled run). */
export const ROUTINE_PROMPT = "/market-research rutyna";
/** Where the owner sets the routine up: a LOCAL routine of the Claude desktop app (a cloud routine, e.g. from
 * `/schedule`, cannot reach the profile's local MCP server). */
export const ROUTINE_MENU = "Claude (aplikacja) › Code › Routines › Nowa rutyna › Lokalna";

// ---- normalisation of loose server values ---------------------------------------------------------------

export function normRelation(v: string | null | undefined): Relation {
  switch ((v ?? "").toLowerCase()) {
    case "supports": case "support": case "supported": return "supports";
    case "weakens": case "weaken": case "weakened": return "weakens";
    case "invalidates": case "invalidate": case "invalidated": return "invalidates";
    case "neutral": return "neutral";
    default: return "none";
  }
}

export function normHealth(v: string | null | undefined): HealthKey | null {
  switch ((v ?? "").toLowerCase()) {
    case "inv": case "invalidated": case "invalidates": case "podważona": return "inv";
    case "weak": case "weakened": case "weakens": case "osłabiona": return "weak";
    case "sup": case "supported": case "supports": case "strengthened": case "wzmocniona": return "sup";
    case "ok": case "current": case "intact": case "neutral": case "aktualna": return "ok";
    case "no_thesis": case "none": case "bez tezy": return "no_thesis";
    case "no_research": case "stale": case "unresearched": case "bez researchu": return "no_research";
    default: return null;
  }
}

export function normDirection(v: string | null | undefined): Direction {
  switch ((v ?? "").toLowerCase()) {
    case "up": case "rising": case "improving": case "rośnie": return "up";
    case "stable": case "flat": case "stabilnie": return "flat";
    case "down": case "falling": case "weakening": case "słabnie": return "down";
    default: return "flat";
  }
}

// ---- dates and freshness (research.md 3) ----------------------------------------------------------------

const DAY = 86400000;
/** Local calendar day of a date or a server datetime (a naive server value is UTC, time.ts). */
const day = (iso: string) => localDay(iso) ?? iso.slice(0, 10);
const dayStart = (iso: string) => new Date(`${day(iso)}T12:00:00`).getTime();
/** Whole calendar days from `a` to `b` (ISO dates or datetimes; local calendar dates). */
export const daysBetween = (a: string, b: string) => Math.round((dayStart(b) - dayStart(a)) / DAY);
export const addDays = (iso: string, n: number) => {
  const t = new Date(dayStart(iso) + n * DAY);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

/** Observed date of a note: `dziś`, `wczoraj`, `sob 3.10` (2-4 days ago), `30.09` (older). */
export function noteWhen(iso: string | null | undefined, today: string): string {
  if (!iso) return "";
  const d = daysBetween(iso, today);
  if (d <= 0) return "dziś";
  if (d === 1) return "wczoraj";
  if (d <= 4) return wdm(iso);
  return dm(iso);
}

/** 7 days = fresh, 8-21 = muted date, older or expired = old (research.md 3). */
export function freshness(observedAt: string, today: string): "fresh" | "muted" | "old" {
  const d = daysBetween(observedAt, today);
  return d <= 7 ? "fresh" : d <= 21 ? "muted" : "old";
}

export const isExpired = (n: Pick<ResearchNote, "expires_at"> & { expired?: boolean }, today: string) => n.expired === true || (!!n.expires_at && day(n.expires_at) < today);

// ---- note accessors (RS CONTRACT 2) ---------------------------------------------------------------------

/** Display name + `symbol · venue` of a note's instrument or candidate. */
export function noteSubject(n: Pick<ResearchNote, "instrument" | "candidate" | "theme" | "title">): { name: string; sym: string | null } {
  const c = n.candidate, i = n.instrument;
  const name = i?.name && i.name !== i.symbol ? i.name : i?.label || c?.name || i?.symbol || c?.symbol || n.theme || n.title;
  const sym = [i?.symbol ?? c?.symbol, i?.mic ?? c?.exchange].filter(Boolean).join(" · ") || null;
  return { name, sym };
}
/** A candidate accepted into the watchlist (date) and its watchlist row. */
export const acceptedAt = (n: Pick<ResearchNote, "candidate">) => n.candidate?.accepted_at ?? null;
export const watchItemId = (n: Pick<ResearchNote, "candidate">) => n.candidate?.watchlist_item_id ?? null;
/** `przywróć` / `Cofnij` window: `restorable_until` from the server, else 15 minutes after the dismissal. */
export function isRestorable(n: Pick<ResearchNote, "dismissed_at" | "restorable_until">, now = Date.now()): boolean {
  if (!n.dismissed_at) return false;
  const until = n.restorable_until ? parseServerTime(n.restorable_until) : parseServerTime(n.dismissed_at) + 15 * 60000;
  return Number.isFinite(until) && now <= until;
}
/** Latest note title of a summary row. */
export const latestTitle = (s: Pick<InstrumentSummary, "latest_note">) => s.latest_note?.title ?? null;
/** Signal state word of a note that created or joined a research signal. */
export const signalWord = (n: Pick<ResearchNote, "signal_id" | "signal">) =>
  n.signal_id == null ? null : !n.signal || ["active", "acknowledged"].includes(n.signal.status) ? "sygnał otwarty" : "sygnał zamknięty";
/** Community noise scale (`details.scale`). */
export const NOISE_SCALE: Record<string, string> = { small: "szum: skala mała", medium: "szum: skala średnia", large: "szum: skala duża" };
export const isLive = (n: Pick<ResearchNote, "expires_at" | "dismissed_at">, today: string) => !n.dismissed_at && !isExpired(n, today);

/** `wygasa 2.11` / `wygasła 2.11`. */
export function expiryText(n: Pick<ResearchNote, "expires_at">, today: string): string | null {
  if (!n.expires_at) return null;
  return `${isExpired(n, today) ? "wygasła" : "wygasa"} ${dm(n.expires_at)}`;
}

/** Source footer text: `publisher · d.m` (falls back to the title, then the host). */
export function sourceText(s: NoteSource): string {
  let who = s.publisher || s.title || "";
  if (!who) { try { who = new URL(s.url).hostname.replace(/^www\./, ""); } catch { who = "źródło"; } }
  return s.published_at ? `${who} · ${dm(s.published_at)}` : who;
}

/** Only http(s) links are rendered as links (a note comes from an agent; never a javascript: URL). */
export const safeUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

// ---- sentiment (research.md 4) --------------------------------------------------------------------------

const SIGN: Record<string, number> = { positive: 1, negative: -1, neutral: 0 };

/** One week's score in [-1, 1]: sum(polarity sign * strength) / (3 * notes); community notes count with
 * strength capped at 1 (noise). Dismissed notes are left out; null = no notes. */
export function weekScore(notes: Pick<ResearchNote, "polarity" | "strength" | "kind" | "dismissed_at">[]): number | null {
  const live = notes.filter((n) => !n.dismissed_at);
  if (!live.length) return null;
  const sum = live.reduce((s, n) => s + (SIGN[n.polarity] ?? 0) * (n.kind === "community" ? 1 : clampStrength(n.strength)), 0);
  return Math.round((sum / (3 * live.length)) * 1000) / 1000;
}

/** Monday (ISO week start) of the week containing `iso`. */
export function weekStart(iso: string): string {
  const t = new Date(dayStart(iso));
  const dow = (t.getDay() + 6) % 7; // Monday = 0
  return addDays(day(iso), -dow);
}

/** The 8 week starts ending with the current week, oldest first. */
export const weekStarts = (today: string, n = 8) => Array.from({ length: n }, (_, i) => addDays(weekStart(today), -7 * (n - 1 - i)));

/** 8 weekly scores (oldest first) for a set of notes; the client fallback of `sentiment_8w`. */
export function sentiment8w(notes: Pick<ResearchNote, "polarity" | "strength" | "kind" | "dismissed_at" | "observed_at">[], today: string): (number | null)[] {
  const weeks = weekStarts(today);
  return weeks.map((w, i) => {
    const end = i + 1 < weeks.length ? weeks[i + 1] : addDays(w, 7);
    return weekScore(notes.filter((n) => day(n.observed_at) >= w && day(n.observed_at) < end));
  });
}

/** Axis labels of the large chart: every other week (`10.08`, ``, `24.08`, ...). */
export const weekLabels = (weeks: string[]) => weeks.map((w, i) => (i % 2 === 0 ? dm(w) : ""));

export interface SentBar { x: number; y: number; w: number; h: number; cls: "pos" | "neg" | "none" }
/** Bar geometry of the sentiment chart (rsch.js `sentiment()`): baseline in the middle, a 2 px tick for an
 * empty week (no data must look different from balanced), bar height = |score| of half the plot height. */
export function sentimentBars(values: (number | null)[], w: number, h: number, labelBand = 0): { mid: number; bars: SentBar[]; slot: number; bw: number } {
  const ph = h - labelBand, mid = Math.round(ph / 2) + 0.5;
  const n = Math.max(1, values.length), slot = w / n, bw = Math.max(2, Math.min(14, slot * 0.58));
  const bars = values.map((v, i): SentBar => {
    const x = Math.round((i * slot + (slot - bw) / 2) * 100) / 100;
    if (v == null || !Number.isFinite(v)) return { x, y: mid - 1, w: bw, h: 2, cls: "none" };
    const c = Math.max(-1, Math.min(1, v));
    const bh = Math.max(2, Math.abs(c) * (mid - 2));
    return { x, y: c >= 0 ? mid - bh : mid, w: bw, h: bh, cls: c > 0 ? "pos" : c < 0 ? "neg" : "none" };
  });
  return { mid, bars, slot, bw };
}

/** Theme direction: sum of the last 4 weeks vs the previous 4 (empty weeks count 0); a difference of more
 * than 1.0 either way is `rośnie` / `słabnie`, else `stabilnie`. */
export function direction(values: (number | null)[]): Direction {
  if (values.length < 2) return "flat";
  const half = Math.floor(values.length / 2);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((s, v) => s + (v ?? 0), 0);
  const d = sum(values.slice(-half)) - sum(values.slice(0, values.length - half));
  return d > 1.0 ? "up" : d < -1.0 ? "down" : "flat";
}

/** `z rośnie na słabnie`. */
export function directionChange(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to || normDirection(from) === normDirection(to)) return null;
  const a = DIRECTION_LABEL[normDirection(from)];
  return `${/^s/.test(a) ? "ze" : "z"} ${a} na ${DIRECTION_LABEL[normDirection(to)]}`;
}

/** The latest non-empty week of a trend: polarity word for the drawer summary. */
export function lastNonEmpty(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i];
  return null;
}

// ---- thesis health (research.md 5; design answer 2: 30 days, reset on thesis edit) -------------------------

export function relationCounts(notes: Pick<ResearchNote, "thesis_relation" | "kind">[]): RelationCounts {
  const c: RelationCounts = { supports: 0, weakens: 0, invalidates: 0, neutral: 0, community: 0 };
  for (const n of notes) {
    if (n.kind === "community") c.community++;
    const r = normRelation(n.thesis_relation);
    if (r === "supports") c.supports++;
    else if (r === "weakens") c.weakens++;
    else if (r === "invalidates") c.invalidates++;
    else if (r === "neutral") c.neutral++;
  }
  return c;
}

/** Health of a position's thesis from its notes. Window: the last 30 days, starting no earlier than the
 * thesis's last edit (an edited thesis starts clean); dismissed and expired notes do not count.
 * `researchedAt` = the last run that covered the instrument (no note needed for `aktualna`). */
export function thesisHealth(o: {
  hasThesis: boolean;
  notes: Pick<ResearchNote, "thesis_relation" | "kind" | "observed_at" | "expires_at" | "dismissed_at">[];
  today: string;
  thesisEditedAt?: string | null;
  researchedAt?: string | null;
}): HealthKey {
  if (!o.hasThesis) return "no_thesis";
  const from = windowStart(o.today, o.thesisEditedAt);
  const win = o.notes.filter((n) => isLive(n, o.today) && day(n.observed_at) >= from);
  const c = relationCounts(win);
  if (c.invalidates) return "inv";
  if (c.weakens) return "weak";
  if (c.supports) return "sup";
  const covered = win.length > 0 || (!!o.researchedAt && day(o.researchedAt) >= addDays(o.today, -30));
  return covered ? "ok" : "no_research";
}

/** First day of the health window: 30 days back, or the thesis edit day when later. */
export function windowStart(today: string, thesisEditedAt?: string | null): string {
  const d30 = addDays(today, -30);
  const edit = thesisEditedAt ? day(thesisEditedAt) : null;
  return edit && edit > d30 ? edit : d30;
}

/** Health of a summary row: the server's value when it sends one, else derived from the counts. */
export function healthOf(s: Pick<InstrumentSummary, "health" | "counts" | "has_thesis" | "last_researched_at">, today: string): HealthKey {
  const h = normHealth(s.health);
  if (h) return h;
  if (s.has_thesis === false) return "no_thesis";
  if (s.counts.invalidates) return "inv";
  if (s.counts.weakens) return "weak";
  if (s.counts.supports) return "sup";
  return s.last_researched_at && day(s.last_researched_at) >= addDays(today, -30) ? "ok" : "no_research";
}

const verb = (n: number, one: string, few: string) => plural(n, one, few, one);
const word = (n: number, one: string, few: string, many: string) => plural(n, one, few, many).replace(/^\d+ /, "");

/** Count line next to the pill: `2 osłabiają · 0 wzmacnia`, `1 wzmacnia · 1 szum`, `3 notatki · ostatnio negatywna`. */
export function countsText(health: HealthKey, c: RelationCounts, o: { notes?: number; latestPolarity?: string | null } = {}): string {
  const parts: string[] = [];
  if (health === "no_thesis" || health === "no_research") {
    if (o.notes) parts.push(plural(o.notes, "notatka", "notatki", "notatek"));
    if (o.latestPolarity && POLARITY_WORD[o.latestPolarity]) parts.push(`ostatnio ${POLARITY_WORD[o.latestPolarity]}`);
    return parts.join(" · ") || (health === "no_research" ? "brak notatek z 30 dni" : "");
  }
  if (c.invalidates) parts.push(verb(c.invalidates, "podważa", "podważają"));
  if (c.weakens || health === "weak") parts.push(verb(c.weakens, "osłabia", "osłabiają"));
  if (c.supports || health === "weak" || health === "inv") parts.push(verb(c.supports, "wzmacnia", "wzmacniają"));
  if (c.community) parts.push(`${c.community} szum`);
  if (!parts.length && c.neutral) parts.push(plural(c.neutral, "neutralna", "neutralne", "neutralnych"));
  return parts.join(" · ");
}

/** A thesis field's chip: `1 notatka osłabia` (most severe relation among the notes touching that field). */
export function fieldChips(notes: Pick<ResearchNote, "thesis_relation" | "thesis_field">[]): Map<string, { relation: Relation; text: string }> {
  const by = new Map<string, Relation[]>();
  for (const n of notes) {
    const f = normField(n.thesis_field ? String(n.thesis_field) : null);
    const r = normRelation(n.thesis_relation);
    if (!f || r === "none" || r === "neutral") continue;
    by.set(f, [...(by.get(f) ?? []), r]);
  }
  const out = new Map<string, { relation: Relation; text: string }>();
  for (const [f, rs] of by) {
    const worst: Relation = rs.includes("invalidates") ? "invalidates" : rs.includes("weakens") ? "weakens" : "supports";
    const k = rs.filter((r) => r === worst).length;
    const v = worst === "invalidates" ? word(k, "podważa", "podważają", "podważa") : worst === "weakens" ? word(k, "osłabia", "osłabiają", "osłabia") : word(k, "wzmacnia", "wzmacniają", "wzmacnia");
    out.set(f, { relation: worst, text: `${plural(k, "notatka", "notatki", "notatek")} ${v}` });
  }
  return out;
}

/** Field chips from the summary's per-field counts (`fields: [{field, supports, weakens, invalidates}]`). */
export function chipsFromFields(fields: { field: string; supports: number; weakens: number; invalidates: number }[]): Map<string, { relation: Relation; text: string }> {
  const notes: { thesis_relation: string; thesis_field: string }[] = [];
  for (const f of fields) {
    for (const [rel, k] of [["supports", f.supports], ["weakens", f.weakens], ["invalidates", f.invalidates]] as [string, number][]) {
      for (let i = 0; i < (k || 0); i++) notes.push({ thesis_relation: rel, thesis_field: f.field });
    }
  }
  return fieldChips(notes);
}

// ---- candidates (research.md 6) -------------------------------------------------------------------------

/** Criteria of a candidate note: the structured `details.criteria`, else a `- [x] text` list in the summary. */
export function candidateCriteria(n: Pick<ResearchNote, "details" | "summary">): { items: Criterion[]; met: number; total: number } {
  let items: Criterion[] = [];
  const raw = n.details?.criteria;
  if (Array.isArray(raw)) {
    items = raw.filter((c) => c && typeof c.text === "string").map((c) => ({ text: c.text, met: !!c.met, threshold: c.threshold ?? null }));
  } else {
    for (const line of (n.summary ?? "").split(/\r?\n/)) {
      const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.+?)\s*$/.exec(line);
      if (m) items.push({ text: m[2], met: m[1] !== " " });
    }
  }
  return { items, met: items.filter((c) => c.met).length, total: items.length };
}

/** One criterion as shown: `-31 % od szczytu 52 tyg. (próg -25 %)`. */
export function criterionText(c: Criterion): string {
  if (c.threshold == null || c.threshold === "") return c.text;
  const t = String(c.threshold);
  return `${c.text} (${/^próg/i.test(t) ? t : `próg ${t}`})`;
}

/** Summary text without the criteria list lines (they render as `.crit`). */
export const summaryWithoutCriteria = (summary: string) => summary.split(/\r?\n/).filter((l) => !/^\s*[-*]\s*\[( |x|X)\]/.test(l)).join("\n").trim();

export const entryTypeLabel = (t: string | null | undefined) => (t ? ENTRY_TYPE[t] ?? t : null);

/** 90-day cooldown of a dismissed candidate (`wraca najwcześniej 26.12`). */
export const candidateReturn = (dismissedAt: string) => addDays(dismissedAt, 90);

// ---- research signals (research.md 2) -------------------------------------------------------------------

export const isResearchKind = (kind: string | null | undefined) => !!kind && kind.startsWith("research:");

interface SigLike { kind: string; message: string; instrument_label: string | null; payload: Record<string, unknown> }
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Note id a research signal points at (the signal's `note_id`, RS CONTRACT; else the payload's). */
export const signalNoteId = (s: Pick<SigLike, "payload">): number | null =>
  num((s as { note_id?: unknown }).note_id) ?? num(s.payload.note_id ?? s.payload.research_note_id);

/** Fact line of a research signal: `osłabia tezę · <b>title</b> · siła 3/3 · 2 źródła`. */
export function researchSignalText(s: SigLike, name: string, sym: string | null): { title: string; sym: string | null; lead?: string; bold?: string; tail?: string } {
  const p = s.payload;
  const rel = normRelation(str(p.thesis_relation) ?? str(p.relation));
  const strength = num(p.strength);
  const srcs = Array.isArray(p.sources) ? p.sources.length : num(p.sources_count ?? p.sources);
  const title = name || str(p.theme) || s.instrument_label || "Research";
  const bold = str(p.title) ?? str(p.note_title) ?? s.message;
  const tail = [strength != null ? `siła ${clampStrength(strength)}/3` : null, srcs ? plural(srcs, "źródło", "źródła", "źródeł") : null].filter(Boolean).join(" · ");
  return { title, sym, lead: rel !== "none" ? `${RELATION_LABEL[rel]} ·` : str(p.kind) ? `${KIND_LABEL[str(p.kind)!] ?? str(p.kind)} ·` : undefined, bold: bold || undefined, tail: tail ? `· ${tail}` : undefined };
}

// ---- runs and the header tag (research.md 7) ------------------------------------------------------------

export const runNotes = (r: Pick<ResearchRun, "counts">): number | null => {
  const c = r.counts ?? {};
  const v = c.notes ?? c.notes_added ?? c.added ?? c.total;
  return typeof v === "number" ? v : null;
};

export const latestRun = (runs: ResearchRun[]): ResearchRun | null =>
  [...runs].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0] ?? null;

/** Last run that finished (done) or was interrupted with notes saved. */
export const lastDone = (runs: ResearchRun[]): ResearchRun | null =>
  [...runs].filter((r) => r.status === "done").sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0] ?? null;

export const nNotes = (n: number) => plural(n, "notatka", "notatki", "notatek");

const hmOf = hmLocal;

export interface RunTag { text: string; tone: "" | "warn" | "info" | "neg"; state: "none" | "fresh" | "stale" | "running" | "failed" }

/** Header tag of the strip / block / view from the runs: `sob 3.10 · 14 notatek`, `brak w tym tygodniu ·
 * ostatni 26.09` (warn, older than 7 days), `trwa · od 06:40 · 9 notatek` (info), `przerwany 06:52 · 4
 * notatki zapisane` (neg), `jeszcze nie działał`. */
export function runTag(runs: ResearchRun[], today: string): RunTag {
  const last = latestRun(runs);
  if (!last) return { text: "jeszcze nie działał", tone: "", state: "none" };
  const notes = runNotes(last);
  if (last.status === "running") return { text: `trwa · od ${hmOf(last.started_at)}${notes != null ? ` · ${nNotes(notes)}` : ""}`, tone: "info", state: "running" };
  if (last.status === "failed") {
    return { text: `przerwany ${hmOf(last.finished_at ?? last.started_at)}${notes ? ` · ${plural(notes, "notatka zapisana", "notatki zapisane", "notatek zapisanych")}` : ""}`, tone: "neg", state: "failed" };
  }
  const at = last.finished_at ?? last.started_at;
  if (daysBetween(at, today) > 7) return { text: `brak w tym tygodniu · ostatni ${dm(at)}`, tone: "warn", state: "stale" };
  return { text: `${wdm(at)}${notes != null ? ` · ${nNotes(notes)}` : ""}`, tone: "", state: "fresh" };
}

/** Pills keep the last state but turn muted after 14 days without a run. */
export const healthStale = (runs: ResearchRun[], today: string) => {
  const d = lastDone(runs);
  return !d || daysBetween(d.finished_at ?? d.started_at, today) > 14;
};

/** The next Saturday (the routine's day; the app does not know the real schedule). */
export function nextSaturday(today: string): string {
  const dow = new Date(dayStart(today)).getDay();
  return addDays(today, (6 - dow + 7) % 7 || 7);
}

/** Run duration in minutes. */
export const runMinutes = (r: Pick<ResearchRun, "started_at" | "finished_at">) =>
  r.finished_at ? Math.max(1, Math.round((parseServerTime(r.finished_at) - parseServerTime(r.started_at)) / 60000)) : null;

// ---- commands (research.md 7; design answer 3: the app copies, never spawns) ---------------------------------

/** The profile's workspace folder (AW `GET workspace`), else the default `~/Documents/finanse/<slug>`. */
export const workspacePath = (path: string | null | undefined, slug: string) => path || `~/Documents/finanse/${slug}`;

/** `cd <workspace> && claude -p "/market-research"`; a path with spaces is quoted (keeping `~/` expandable). */
export function researchCommand(path: string | null | undefined, slug: string): string {
  const p = workspacePath(path, slug);
  const cd = !/\s/.test(p) ? p : p.startsWith("~/") ? `~/"${p.slice(2)}"` : `"${p}"`;
  return `cd ${cd} && claude -p "${RESEARCH_SKILL}"`;
}
/** One line of the local routine setup: menu path, day and time, folder, prompt. */
export const scheduleSteps = (path: string | null | undefined, slug: string) =>
  `${ROUTINE_MENU}: sobota 07:00, folder ${workspacePath(path, slug)}, polecenie ${ROUTINE_PROMPT}`;

// ---- home grid (research.md 1; ia-v2 density rule) -------------------------------------------------------

/** The strip appears only after the first run exists (density rule): any run, running or finished. */
export const showStrip = (runs: ResearchRun[] | null | undefined) => !!runs && runs.length > 0;

/** Position of the research strip in the home grid: right after the attention row (Sygnały + Alerty),
 * before the charts; at two columns it waits for the Alerty + Alokacja pair (`defer`). The signals-rail home
 * (one `split` cell holding both) gets it before that cell. */
export function insertAfterAttention<T extends { id: string }>(items: T[], strip: T): T[] {
  const i = items.findIndex((x) => x.id === "alerts");
  let at = i >= 0 ? i + 1 : items.findIndex((x) => x.id === "value");
  if (at < 0) at = items.findIndex((x) => x.id === "split");
  if (at < 0) return [...items, strip];
  return [...items.slice(0, at), strip, ...items.slice(at)];
}

/** Rows of the `Tezy` column: held positions, most severe health first, then weight. */
export function orderTheses<T extends { health: HealthKey; weight?: number | null; label?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || (b.weight ?? 0) - (a.weight ?? 0) || (a.label ?? "").localeCompare(b.label ?? ""));
}
