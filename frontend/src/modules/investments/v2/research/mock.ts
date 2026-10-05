// Dev-only demo data of the research layer (`VITE_MOCK=1`), plugged into v2/mock.ts: runs, notes (held
// positions, a watched instrument, themes, candidates), the summary, dismiss / restore, candidate accept /
// undo, research signals and the review digest block. Invented content only (no real reports, no real
// URLs beyond example.org). Scenarios via the query string: `?research=none` (never ran), `stale` (last run
// 26.09), `running`, `failed`.
import { ApiError } from "../../../../core/api";
import { KIND_LABEL, RELATION_LABEL, relationCounts, sentiment8w } from "./logic";
import { plural } from "../../labels";
import type { DigestResearch, InstrumentSummary, ResearchNote, ResearchRun, ResearchSummary, ThemeSummary } from "./types";

const SCENARIO = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("research") ?? "";
const TODAY = "2026-10-04";

interface RState { notes: ResearchNote[]; runs: ResearchRun[]; nextId: number }
const states = new Map<string, RState>();

const src = (publisher: string, date: string, path: string) => ({ title: publisher, publisher, url: `https://example.org/${path}`, published_at: date });
const inst = (id: number, label: string, symbol: string, mic: string | null = "XWAR") => ({ id, label, name: label, symbol, mic });

let seq = 600;
function note(o: Partial<ResearchNote> & Pick<ResearchNote, "kind" | "title" | "summary" | "observed_at">): ResearchNote {
  const observed = o.observed_at;
  const exp = new Date(new Date(observed).getTime() + 30 * 86400000).toISOString();
  return {
    id: ++seq, run_id: 3, instrument_id: null, instrument: null, theme: null, polarity: "neutral", strength: 1, thesis_relation: "none", thesis_field: null,
    sources: [src("Parkiet", observed.slice(0, 10), `n${seq}`)], expires_at: exp, created_by: "agent", dismissed_at: null, details: null, signal_id: null, ...o,
  };
}

const SAT = "2026-10-03T06:52:00+02:00";
function janNotes(): ResearchNote[] {
  const cdr = inst(306, "CD Projekt", "CDR"), kgh = inst(305, "KGHM", "KGH"), eimi = inst(307, "iShares MSCI EM IMI", "EIMI", null);
  const pkn = inst(304, "PKN Orlen", "PKN"), vwra = inst(301, "Vanguard FTSE All-World", "VWRA", null);
  return [
    note({ instrument_id: 306, instrument: cdr, kind: "news", polarity: "negative", strength: 3, thesis_relation: "weakens", thesis_field: "thesis", observed_at: SAT, signal_id: 961, signal: { id: 961, status: "active", severity: "info" },
      title: "Premiera głównego tytułu przesunięta z 2027 na I półrocze 2028",
      summary: "W komunikacie po wynikach Q3 spółka przesunęła premierę o ok. dwa kwartały; budżet produkcji bez zmian. Dotyka założenia wejścia „premiery gier w 2027”; kryteria unieważnienia (udział w rynku, zarząd) bez zmian.",
      sources: [src("Parkiet", "2026-10-02", "cdr-1"), src("komunikat spółki", "2026-10-01", "cdr-2")] }),
    note({ instrument_id: 306, instrument: cdr, kind: "earnings", polarity: "neutral", strength: 2, thesis_relation: "weakens", thesis_field: "thesis", observed_at: "2026-09-30T18:00:00+02:00", run_id: 2,
      title: "Q3: przychody niżej r/r przy stałych kosztach produkcji",
      summary: "Przychody -12 % r/r (mniejsza sprzedaż katalogu), koszty rozwoju bez zmian, gotówka netto dodatnia. Wycena nadal poniżej mediany 5 lat, więc samo założenie wyceny się trzyma.",
      sources: [src("raport kwartalny", "2026-09-30", "cdr-3"), src("PAP Biznes", "2026-09-30", "cdr-4")] }),
    note({ instrument_id: 306, instrument: cdr, kind: "community", polarity: "negative", strength: 1, thesis_relation: "neutral", observed_at: SAT,
      title: "Nastroje na forach negatywne po przesunięciu premiery",
      summary: "Reddit i forum Bankier: ok. 70 % wpisów negatywnych w 41 wpisach z tygodnia; mała skala, dużo powtórzeń. Kierunek zgodny z wiadomościami, bez nowych faktów.",
      sources: [src("Reddit r/inwestowanie", "2026-10-03", "cdr-5"), src("forum Bankier", "2026-10-02", "cdr-6")], expires_at: "2026-10-17T06:52:00+02:00", details: { scale: "small" } }),
    note({ instrument_id: 306, instrument: cdr, kind: "trend", polarity: "neutral", strength: 1, thesis_relation: "neutral", observed_at: SAT,
      title: "Zainteresowanie wyszukiwaniami tytułu -18 % m/m",
      summary: "Trend wyszukiwań dla głównej marki spadł trzeci miesiąc z rzędu, nadal powyżej średniej z 2025. Zwykłe przed premierą po przesunięciu daty.",
      sources: [src("Google Trends", "2026-10-03", "cdr-7")] }),
    note({ instrument_id: 306, instrument: cdr, kind: "news", polarity: "positive", strength: 1, thesis_relation: "supports", thesis_field: "thesis", observed_at: "2026-09-19T07:00:00+02:00", run_id: 1,
      expires_at: "2026-10-19T07:00:00+02:00", title: "Wycena poniżej mediany 5 lat potwierdzona w raporcie sektorowym",
      summary: "Raport sektorowy: wskaźnik ceny do zysku spółki poniżej mediany pięciu lat.", sources: [src("raport sektorowy", "2026-09-18", "cdr-8")] }),
    note({ instrument_id: 306, instrument: cdr, kind: "macro", polarity: "neutral", strength: 1, thesis_relation: "neutral", observed_at: "2026-09-05T07:00:00+02:00", run_id: 1,
      expires_at: "2026-10-05T07:00:00+02:00", title: "Kurs USD/PLN a przychody eksportowe", summary: "Słabszy dolar obniża przychody w złotych o kilka procent.", sources: [src("NBP", "2026-09-04", "cdr-9")] }),
    note({ instrument_id: 305, instrument: kgh, kind: "trend", polarity: "positive", strength: 2, thesis_relation: "supports", theme: "Miedź i metale przemysłowe", observed_at: SAT,
      title: "Miedź: deficyt podaży trzeci kwartał z rzędu, popyt z energetyki i AI",
      summary: "Zapasy na giełdach metali najniżej od 2021, kontrakty terminowe w backwardation. Siła relatywna KGH vs WIG20 +6 pp w 8 tyg. Zgodne z tezą „trend”.",
      sources: [src("Reuters", "2026-10-01", "kgh-1"), src("raport ICSG", "2026-09-29", "kgh-2"), src("stooq", "2026-10-03", "kgh-3")] }),
    note({ instrument_id: 305, instrument: kgh, kind: "community", polarity: "negative", strength: 1, thesis_relation: "neutral", observed_at: SAT,
      title: "Nastroje wokół KGHM na forach negatywne po wynikach",
      summary: "Forum Bankier i Reddit: przewaga wpisów negatywnych (ok. 60 %) w 28 wpisach; temat dywidendy i podatku od kopalin. Mała skala, dużo powtórzeń.",
      sources: [src("forum Bankier", "2026-10-02", "kgh-4"), src("Reddit r/inwestowanie", "2026-10-01", "kgh-5")], expires_at: "2026-10-17T06:52:00+02:00" }),
    note({ instrument_id: 307, instrument: eimi, kind: "trend", polarity: "negative", strength: 2, thesis_relation: "weakens", theme: "Rynki wschodzące: przepływy ETF", observed_at: SAT,
      title: "Odpływy z ETF rynków wschodzących trzeci tydzień z rzędu",
      summary: "Łączne odpływy z ETF EM w 3 tyg. ok. 2,1 mld $; EIMI i XMME po stronie odpływów. Siła relatywna vs ACWI -4 pp od sierpnia.",
      sources: [src("ETF flows", "2026-10-03", "eimi-1"), src("justETF", "2026-10-02", "eimi-2")] }),
    note({ instrument_id: 304, instrument: pkn, kind: "earnings", polarity: "negative", strength: 2, thesis_relation: "none", observed_at: "2026-09-30T18:00:00+02:00", run_id: 2,
      title: "Q3: marże rafineryjne niżej r/r, wolumeny stabilne",
      summary: "Modelowa marża rafineryjna -18 % r/r, segment detaliczny bez zmian. Pozycja bez zapisanej tezy; notatka trafia tylko do profilu instrumentu.",
      sources: [src("raport Q3", "2026-09-30", "pkn-1"), src("PAP Biznes", "2026-09-30", "pkn-2")] }),
    note({ instrument_id: 301, instrument: vwra, kind: "macro", polarity: "neutral", strength: 1, thesis_relation: "none", theme: "Stopy procentowe USA", observed_at: "2026-10-01T09:00:00+02:00",
      title: "Fed obniżył stopy o 25 pb, rentowności 10Y spadły do 3,9 %",
      summary: "Trzecia obniżka w cyklu, komunikat bez zmiany ścieżki. Dotyczy wyceny indeksów globalnych; bez wpływu na tezy pozycji.",
      sources: [src("Fed", "2026-09-30", "fed-1"), src("Bloomberg", "2026-10-01", "fed-2")] }),
    note({ theme: "Gry wideo: premiery 2027", kind: "trend", polarity: "negative", strength: 2, thesis_relation: "none", observed_at: SAT,
      title: "Sektor gier: dwie duże premiery przesunięte na 2028", summary: "Poza CDR jeszcze jeden wydawca przesunął premierę; trend wyszukiwań sektora -18 % m/m.",
      sources: [src("GamesIndustry", "2026-10-02", "games-1")] }),
    note({ theme: "Energia odnawialna: napływy", kind: "trend", polarity: "positive", strength: 2, thesis_relation: "none", observed_at: SAT,
      title: "Napływy do ETF energii odnawialnej 5 tyg. z rzędu", summary: "Napływy do ETF sektora piąty tydzień z rzędu; siła relatywna vs ACWI +8 pp.",
      sources: [src("ETF flows", "2026-10-03", "re-1")] }),
    note({ candidate: { symbol: "TXT", name: "Text", exchange: "XWAR", currency: "PLN", key: "TXT" }, kind: "candidate", polarity: "neutral", strength: 2, thesis_relation: "none", observed_at: "2026-10-01T09:00:00+02:00",
      title: "Text: korekta sentymentu przy stabilnych przychodach",
      summary: "Kurs -31 % od szczytu 52 tyg. przy stabilnych przychodach od 4 kwartałów; sentyment społeczności negatywny (szum), wiadomości neutralne.",
      details: { entry_type: "sentiment_correction", context: "sentyment społeczności negatywny (szum) · wiadomości neutralne", criteria: [
        { text: "-31 % od szczytu 52 tyg.", met: true, threshold: "-25 %" }, { text: "przychody stabilne 4 kwartały", met: true }, { text: "brak w portfelu, koszyk Akcje", met: true },
      ] }, sources: [src("Bankier", "2026-10-01", "txt-1"), src("raport kwartalny", "2026-08-28", "txt-2")] }),
    note({ candidate: { symbol: "INRG", name: "Global Clean Energy", exchange: "XLON", currency: "GBP", key: "INRG" }, kind: "candidate", polarity: "positive", strength: 2, thesis_relation: "none", observed_at: SAT,
      title: "Global Clean Energy: napływy i siła relatywna",
      summary: "Napływy do ETF 5 tyg. z rzędu, siła relatywna vs ACWI +8 pp; kurs poniżej SMA 200 od 6 tygodni.",
      details: { entry_type: "trend", context: "temat: Energia odnawialna · koszyk Akcje globalne", criteria: [
        { text: "napływy do ETF 5 tyg. z rzędu", met: true }, { text: "siła relatywna vs ACWI +8 pp", met: true }, { text: "powyżej SMA 200 od 6 tyg.", met: false, threshold: "8" },
      ] }, sources: [src("ETF flows", "2026-10-03", "inrg-1"), src("justETF", "2026-10-02", "inrg-2"), src("stooq", "2026-10-03", "inrg-3")] }),
    note({ candidate: { symbol: "ACP", name: "Asseco Poland", exchange: "XWAR", currency: "PLN", key: "ACP" }, kind: "candidate", polarity: "neutral", strength: 1, thesis_relation: "none", observed_at: "2026-09-26T09:00:00+02:00", run_id: 2,
      title: "Asseco Poland: przegląd opcji strategicznych", summary: "Spółka ogłosiła przegląd opcji strategicznych.", dismissed_at: "2026-09-27T10:00:00+02:00", cooldown_until: "2026-12-26T10:00:00+01:00",
      details: { entry_type: "special_situation", context: "odrzucony: „poza kompetencjami”", criteria: [{ text: "ogłoszony przegląd opcji", met: true }] },
      sources: [src("ESPI", "2026-09-25", "acp-1")] }),
  ];
}

function janRuns(): ResearchRun[] {
  const run = (id: number, start: string, end: string | null, status: string, notes: number, signals: number, scope: string[], by = "agent", scheduled = true): ResearchRun => ({
    id, started_at: start, finished_at: end, status, interrupted: status === "failed", reason: status === "failed" ? "interrupted" : null,
    duration_s: end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null, scheduled, created_by: by, notes, signals,
    scope: { held: scope.includes("positions"), watchlist: scope.includes("watchlist"), candidates: scope.includes("candidates"), themes: scope.includes("themes") ? ["Gry wideo: premiery 2027", "Miedź i metale przemysłowe"] : [], instrument_ids: scope.includes("KGH") ? [305] : [], covered_instrument_ids: [301, 304, 305, 306, 307] },
    counts: { notes, signals, candidates: notes > 5 ? 2 : 0, by_kind: { news: 3, earnings: 2, community: notes > 5 ? 3 : 0, trend: 4, macro: 2, candidate: notes > 5 ? 2 : 0 }, sources_checked: notes ? notes - 3 : 0, instruments_covered: 9 },
  });
  const all = ["positions", "watchlist", "candidates", "themes"];
  const runs = [
    run(1, "2026-09-12T06:40:00+02:00", "2026-09-12T07:09:00+02:00", "done", 11, 0, all),
    run(4, "2026-09-19T06:40:00+02:00", "2026-09-19T06:51:00+02:00", "failed", 4, 0, ["positions", "watchlist"]),
    run(5, "2026-09-21T19:12:00+02:00", "2026-09-21T19:18:00+02:00", "done", 3, 0, ["KGH"], "user", false),
    run(2, "2026-09-26T06:40:00+02:00", "2026-09-26T07:07:00+02:00", "done", 9, 0, all),
    run(3, "2026-10-03T06:40:00+02:00", "2026-10-03T07:12:00+02:00", "done", 14, 1, all),
  ];
  if (SCENARIO === "stale") return runs.filter((r) => r.id !== 3);
  if (SCENARIO === "running") return [...runs.filter((r) => r.id !== 3), run(3, `${TODAY}T06:40:00+02:00`, null, "running", 9, 0, all)];
  if (SCENARIO === "failed") return [...runs.filter((r) => r.id !== 3), run(3, "2026-10-03T06:40:00+02:00", "2026-10-03T06:52:00+02:00", "failed", 4, 0, all)];
  return runs;
}

function stateFor(slug: string, kind: string): RState {
  let st = states.get(slug);
  if (!st) {
    const on = slug === "jan" && kind === "full" && SCENARIO !== "none";
    st = { notes: on ? janNotes() : [], runs: on ? janRuns() : [], nextId: 9500 };
    if (on && SCENARIO === "stale") st.notes = st.notes.filter((n) => n.observed_at < "2026-10-02");
    states.set(slug, st);
  }
  return st;
}

// ---- summary --------------------------------------------------------------------------------------------
const SENT: Record<number, (number | null)[]> = {
  306: [0.3, 0.2, null, -0.2, -0.3, null, -0.6, -0.9], 305: [0.1, 0.4, 0.2, null, 0.5, 0.3, -0.2, 0.6], 307: [null, 0.2, 0.1, -0.1, null, -0.3, -0.4, -0.5],
  304: [null, 0.3, null, 0.1, -0.2, null, null, -0.4], 301: [0.1, null, 0.2, 0.1, null, 0.3, null, 0.2],
};
const HEALTH: Record<number, string> = { 306: "weakened", 305: "supported", 307: "weakened", 304: "no_thesis", 301: "no_thesis" }; // server wire names
const WEIGHT: Record<number, number> = { 301: 0.409, 302: 0.126, 303: 0.161, 304: 0.133, 305: 0.055, 306: 0.057, 307: 0.006 };
const THEMES: ThemeSummary[] = [
  { theme: "Gry wideo: premiery 2027", key: "gry-wideo", sentiment_8w: [0.2, 0.3, null, 0, -0.2, -0.3, -0.5, -0.8], direction: "falling", notes: 4, instruments: [306], last_observed_at: "2026-10-03",
    last_note: { title: "Premiera przesunięta na 2028", observed_at: "2026-10-03", strength: 3, thesis_relation: "weakens", polarity: "negative" } },
  { theme: "Miedź i metale przemysłowe", key: "miedz", sentiment_8w: [0.1, 0.3, 0.2, 0.4, null, 0.5, 0.3, 0.6], direction: "stable", notes: 3, instruments: [305], last_observed_at: "2026-10-03",
    last_note: { title: "Deficyt podaży trzeci kwartał z rzędu", observed_at: "2026-10-01", strength: 2, thesis_relation: "supports", polarity: "positive" } },
  { theme: "Rynki wschodzące: przepływy ETF", key: "em-etf", sentiment_8w: [0.3, 0.2, 0.1, null, -0.2, -0.3, -0.4, -0.5], direction: "falling", notes: 2, instruments: [307, 403], last_observed_at: "2026-10-03",
    last_note: { title: "Odpływy z ETF EM trzeci tydzień", observed_at: "2026-10-03", strength: 2, thesis_relation: "weakens", polarity: "negative" } },
  { theme: "Stopy procentowe USA", key: "stopy-usa", sentiment_8w: [null, 0.1, null, 0.2, 0.1, null, 0.3, 0.2], direction: "stable", notes: 2, instruments: [301, 302], last_observed_at: "2026-10-01",
    last_note: { title: "Fed -25 pb, 10Y 3,9 %", observed_at: "2026-10-01", strength: 1, thesis_relation: "neutral", polarity: "neutral" } },
  { theme: "Energia odnawialna: napływy", key: "oze", sentiment_8w: [-0.2, null, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4], direction: "rising", notes: 3, instruments: [], last_observed_at: "2026-10-03",
    last_note: { title: "Napływy do ETF 5 tyg. z rzędu", observed_at: "2026-10-03", strength: 2, thesis_relation: "none", polarity: "positive" } },
];

function summary(st: RState): ResearchSummary {
  const live = st.notes.filter((n) => !n.dismissed_at && n.kind !== "candidate");
  const instruments: InstrumentSummary[] = [306, 305, 307, 304, 301].map((id) => {
    const mine = live.filter((n) => n.instrument_id === id).sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    const latest = mine[0];
    const i = latest?.instrument ?? st.notes.find((n) => n.instrument_id === id)?.instrument;
    const health = !mine.length && HEALTH[id] !== "no_thesis" ? "no_research" : HEALTH[id];
    return {
      instrument_id: id, instrument: i ? { ...i, isin: null, currency: "PLN" } : null, label: i?.label ?? null, held: true, watched: false, weight: WEIGHT[id] ?? null,
      has_thesis: HEALTH[id] !== "no_thesis", entry_type: id === 306 ? "sentiment_correction" : null, health,
      health_rank: ["invalidated", "weakened", "no_research", "no_thesis", "supported", "current"].indexOf(health),
      counts: relationCounts(mine), thesis_relation: latest?.thesis_relation ?? null, note_ids: mine.map((n) => n.id),
      fields: id === 306 ? [{ field: "thesis", supports: 1, weakens: mine.filter((n) => n.thesis_relation === "weakens").length, invalidates: 0, neutral: 0 }] : [],
      latest_polarity: latest?.polarity ?? null,
      latest_note: latest ? { id: latest.id, title: shortTitle(latest.title) ?? latest.title, kind: latest.kind, polarity: latest.polarity, thesis_relation: latest.thesis_relation, observed_at: latest.observed_at } : null,
      notes: mine.length,
      sentiment_8w: mine.length ? SENT[id] ?? sentiment8w(mine, TODAY) : sentiment8w([], TODAY),
      direction: id === 306 || id === 307 ? "falling" : "stable",
      last_researched_at: st.runs.filter((r) => r.status === "done").map((r) => r.finished_at).sort().slice(-1)[0] ?? null,
    };
  });
  const weekStarts = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];
  return {
    as_of: TODAY, window_days: 30, weeks: weekStarts.map((_, k) => `2026-W${33 + k}`), week_starts: weekStarts,
    last_run: [...st.runs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null, running: st.runs.some((r) => r.status === "running"),
    instruments, themes: st.runs.length ? THEMES : [],
  };
}
const SHORT: Record<string, string> = {
  "Premiera głównego tytułu przesunięta z 2027 na I półrocze 2028": "premiera przesunięta na 2028 · 2 źródła",
  "Miedź: deficyt podaży trzeci kwartał z rzędu, popyt z energetyki i AI": "miedź: deficyt podaży, popyt z energetyki",
  "Odpływy z ETF rynków wschodzących trzeci tydzień z rzędu": "odpływy z ETF EM trzeci tydzień z rzędu",
  "Q3: marże rafineryjne niżej r/r, wolumeny stabilne": "wyniki Q3: marże rafineryjne niżej r/r",
  "Fed obniżył stopy o 25 pb, rentowności 10Y spadły do 3,9 %": "makro: obniżka stóp Fed, rentowności w dół",
};
const shortTitle = (t?: string) => (t ? SHORT[t] ?? t : null);

// ---- signals and the review digest ----------------------------------------------------------------------
export function researchSignals(slug: string, kind: string, status: string): Record<string, unknown>[] {
  const st = stateFor(slug, kind);
  const n = st.notes.find((x) => x.signal_id === 961);
  if (!n) return [];
  const open = !n.dismissed_at;
  if (status === "open" && !open) return [];
  if (status === "history" && open) return [];
  return [{
    id: 961, rule_id: "research:news", kind: "research:news", dedup_key: "research:306:2026-W40", severity: "info", status: open ? "active" : "resolved", polarity: "negative", source: "research",
    alert_id: null, message: `Analiza (${KIND_LABEL.news}, ${RELATION_LABEL.weakens}): ${n.title}; siła 3/3, ${plural(n.sources.length, "źródło", "źródła", "źródeł")}`, instrument_id: 306, instrument_label: "CD Projekt", account_id: null, note_id: n.id,
    payload: { note_id: n.id, note_ids: [n.id], notes: 1, title: "premiera przesunięta na 2028", relation: "weakens", strength: 3, sources: n.sources.length, kind: "news", symbol: "CDR", name: "CD Projekt", thesis_field: "thesis", week: "2026-W40" },
    first_seen_at: SAT, last_seen_at: SAT, acknowledged_at: null, closed_at: open ? null : n.dismissed_at, decisions: [],
  }];
}

export function researchDigest(slug: string, kind: string): DigestResearch | null {
  const st = stateFor(slug, kind);
  if (!st.runs.length) return null;
  const since = "2026-09-27";
  const fresh = st.notes.filter((n) => n.observed_at.slice(0, 10) >= since);
  const run = [...st.runs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  return {
    since, run, ran_in_period: run.started_at.slice(0, 10) >= since && run.status !== "running", runs_in_period: st.runs.filter((r) => r.started_at.slice(0, 10) >= since).length,
    notes_count: fresh.length, counts: relationCounts(fresh), signals_count: fresh.filter((n) => n.signal_id).length, theses_unchanged: 2,
    theses_changed: [
      { instrument_id: 306, label: "CD Projekt", symbol: "CDR", from: "current", to: "weakened", note_ids: fresh.filter((n) => n.instrument_id === 306 && n.thesis_relation === "weakens").map((n) => n.id) },
      { instrument_id: 305, label: "KGHM", symbol: "KGH", from: "current", to: "supported", note_ids: fresh.filter((n) => n.instrument_id === 305).map((n) => n.id) },
      { instrument_id: 307, label: "iShares MSCI EM IMI", symbol: "EIMI", from: "current", to: "weakened", note_ids: fresh.filter((n) => n.instrument_id === 307).map((n) => n.id) },
    ],
    themes_changed: [{ theme: "Gry wideo: premiery 2027", from: "up", to: "down" }, { theme: "Rynki wschodzące: przepływy ETF", from: "flat", to: "down" }],
    candidates: fresh.filter((n) => n.kind === "candidate").map((n) => n.id),
  };
}

// ---- router ---------------------------------------------------------------------------------------------
/** Server-computed note fields (RS CONTRACT 2). */
function decorate(n: ResearchNote): ResearchNote {
  const expired = !!n.expires_at && n.expires_at.slice(0, 10) < TODAY;
  return {
    ...n, expired, dismissed: !!n.dismissed_at, restorable_until: n.dismissed_at ? new Date(Date.parse(n.dismissed_at) + 15 * 60000).toISOString() : null,
    held: n.instrument_id != null && n.instrument_id < 400, watched: !!n.candidate?.accepted_at,
  };
}
export interface WatchHooks { add: (symbol: string, name: string, note: string) => number; remove: (id: number) => void }

export function researchMock(slug: string, kind: string, ip: string, q: URLSearchParams, method: string, body: unknown, watch: WatchHooks): unknown {
  const st = stateFor(slug, kind);
  const b = (body ?? {}) as Record<string, unknown>;
  if (ip === "/research/runs") return st.runs;
  if (ip === "/research/summary") return summary(st);
  if (ip === "/research" && method === "GET") {
    const instrument = q.get("instrument"), theme = q.get("theme"), k = q.get("kind"), since = q.get("since");
    const withDismissed = q.get("include_dismissed") === "true", withExpired = q.get("include_expired") === "true";
    return st.notes.map(decorate)
      .filter((n) => (instrument == null || String(n.instrument_id) === instrument) && (!theme || n.theme === theme) && (!k || k.split(",").includes(n.kind)) && (!since || n.observed_at >= since)
        && (withDismissed || !n.dismissed_at) && (withExpired || !n.expired))
      .sort((a, b2) => b2.observed_at.localeCompare(a.observed_at));
  }
  let m = /^\/research\/(\d+)$/.exec(ip);
  if (m && method === "PATCH") {
    const n = st.notes.find((x) => x.id === Number(m![1]));
    if (!n) throw new ApiError(404, "Research note not found");
    if (b.dismissed === true && !n.dismissed_at) { n.dismissed_at = new Date().toISOString(); if (n.kind === "candidate") n.cooldown_until = new Date(Date.now() + 90 * 86400000).toISOString(); }
    if (b.dismissed === false && n.dismissed_at) {
      if (Date.now() - Date.parse(n.dismissed_at) > 15 * 60000) throw new ApiError(409, "Too late to restore", "undo_expired");
      n.dismissed_at = null; n.cooldown_until = null;
    }
    if (n.signal) n.signal = { ...n.signal, status: n.dismissed_at ? "resolved" : "active" };
    return decorate(n);
  }
  m = /^\/research\/(\d+)\/accept$/.exec(ip);
  if (m) {
    const n = st.notes.find((x) => x.id === Number(m![1]));
    if (!n || n.kind !== "candidate" || !n.candidate) throw new ApiError(404, "Candidate note not found", "not_found");
    if (method === "POST") {
      if (n.candidate.accepted_at || n.dismissed_at) throw new ApiError(409, "Candidate already accepted or dismissed", "research_conflict");
      const id = watch.add(n.candidate.symbol ?? "X", n.candidate.name ?? "X", `kandydat: ${n.title}`);
      n.candidate = { ...n.candidate, accepted_at: new Date().toISOString(), watchlist_item_id: id, thesis_id: st.nextId++ };
      return { note: decorate(n), watchlist_item: { id }, thesis: { id: n.candidate.thesis_id }, created_instrument: true, warnings: [] };
    }
    if (method === "DELETE") {
      if (n.candidate.watchlist_item_id) watch.remove(n.candidate.watchlist_item_id);
      n.candidate = { ...n.candidate, accepted_at: null, watchlist_item_id: null, thesis_id: null };
      return decorate(n);
    }
  }
  throw new ApiError(404, "Not Found");
}
