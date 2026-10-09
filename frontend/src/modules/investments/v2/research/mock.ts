// Dev-only demo data of the research layer (`VITE_MOCK=1`), plugged into v2/mock.ts: runs, notes (held
// positions, a watched instrument, market segments, macro regimes, candidates), the summary, the segment attribution (P5),
// the macro regimes (P6; `?macro=missing` flips the EM card to missing),
// dismiss / restore, candidate accept / undo, research signals and the review digest block. Invented content only (no real reports, no real
// URLs beyond example.org). Scenarios via the query string: `?research=none` (never ran), `stale` (last run
// 26.09), `running`, `failed`.
import { ApiError } from "../../../../core/api";
import { addDays, KIND_LABEL, RELATION_LABEL, relationCounts, sentiment8w } from "./logic";
import { plural } from "../../labels";
import { stateLabel } from "./macro";
import type { DigestResearch, InstrumentSummary, MacroRegime, MacroRegimes, ResearchNote, ResearchRun, ResearchSummary, SegmentAttribution, SegmentRow } from "./types";

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
    note({ instrument_id: 305, instrument: kgh, kind: "trend", polarity: "positive", strength: 2, thesis_relation: "supports", observed_at: SAT,
      title: "Miedź: deficyt podaży trzeci kwartał z rzędu, popyt z energetyki i AI",
      summary: "Zapasy na giełdach metali najniżej od 2021, kontrakty terminowe w backwardation. Siła relatywna KGH vs WIG20 +6 pp w 8 tyg. Zgodne z tezą „trend”.",
      sources: [src("Reuters", "2026-10-01", "kgh-1"), src("raport ICSG", "2026-09-29", "kgh-2"), src("stooq", "2026-10-03", "kgh-3")] }),
    note({ instrument_id: 305, instrument: kgh, kind: "community", polarity: "negative", strength: 1, thesis_relation: "neutral", observed_at: SAT,
      title: "Nastroje wokół KGHM na forach negatywne po wynikach",
      summary: "Forum Bankier i Reddit: przewaga wpisów negatywnych (ok. 60 %) w 28 wpisach; temat dywidendy i podatku od kopalin. Mała skala, dużo powtórzeń.",
      sources: [src("forum Bankier", "2026-10-02", "kgh-4"), src("Reddit r/inwestowanie", "2026-10-01", "kgh-5")], expires_at: "2026-10-17T06:52:00+02:00" }),
    note({ instrument_id: 307, instrument: eimi, kind: "trend", polarity: "negative", strength: 2, thesis_relation: "weakens", observed_at: SAT,
      title: "Odpływy z ETF rynków wschodzących trzeci tydzień z rzędu",
      summary: "Łączne odpływy z ETF EM w 3 tyg. ok. 2,1 mld $; EIMI i XMME po stronie odpływów. Siła relatywna vs ACWI -4 pp od sierpnia.",
      sources: [src("ETF flows", "2026-10-03", "eimi-1"), src("justETF", "2026-10-02", "eimi-2")] }),
    note({ instrument_id: 304, instrument: pkn, kind: "earnings", polarity: "negative", strength: 2, thesis_relation: "none", observed_at: "2026-09-30T18:00:00+02:00", run_id: 2,
      title: "Q3: marże rafineryjne niżej r/r, wolumeny stabilne",
      summary: "Modelowa marża rafineryjna -18 % r/r, segment detaliczny bez zmian. Pozycja bez zapisanej tezy; notatka trafia tylko do profilu instrumentu.",
      sources: [src("raport Q3", "2026-09-30", "pkn-1"), src("PAP Biznes", "2026-09-30", "pkn-2")] }),
    note({ instrument_id: 301, instrument: vwra, kind: "macro", polarity: "neutral", strength: 1, thesis_relation: "none", observed_at: "2026-10-01T09:00:00+02:00",
      title: "Fed obniżył stopy o 25 pb, rentowności 10Y spadły do 3,9 %",
      summary: "Trzecia obniżka w cyklu, komunikat bez zmiany ścieżki. Dotyczy wyceny indeksów globalnych; bez wpływu na tezy pozycji.",
      sources: [src("Fed", "2026-09-30", "fed-1"), src("Bloomberg", "2026-10-01", "fed-2")] }),
    // P5 segment notes (no instrument): one per segment and week, short; 901 and 904 are this week's.
    note({ id: 901, segment: "gold", segment_label: "Złoto i górnicy", kind: "macro", polarity: "negative", strength: 2, thesis_relation: "none", observed_at: SAT,
      title: "Fed: realne stopy w dół, GDXJ -4,4 % w tygodniu", summary: "Realne rentowności 10Y w górę o 15 pb po danych z rynku pracy; złoto -2,1 % w tygodniu, górnicy mocniej. Segment -0,8 pp portfela.",
      sources: [src("Fed", "2026-10-02", "gold-1")] }),
    note({ id: 902, segment: "semis_ai", segment_label: "AI: chipy i centra danych", kind: "news", polarity: "positive", strength: 2, thesis_relation: "none", observed_at: "2026-09-18T07:00:00+02:00", run_id: 1,
      title: "TSMC: przychody wrzesień +30 % r/r", summary: "Miesięczne przychody TSMC +30 % r/r, popyt na układy do centrów danych. Segment +0,4 pp portfela.",
      sources: [src("TSMC", "2026-09-17", "semis-1")] }),
    note({ id: 903, segment: "bonds", segment_label: "Obligacje i stopy", kind: "macro", polarity: "neutral", strength: 1, thesis_relation: "none", observed_at: "2026-09-25T07:00:00+02:00", run_id: 2,
      title: "Rynek oczekuje stabilnych stóp procentowych", summary: "Kontrakty na stopę referencyjną wyceniają brak zmian do końca roku. EDO bez wpływu na wycenę (koszt).",
      sources: [src("NBP", "2026-09-24", "bonds-1")] }),
    // Stored before the P7 rename: the old key `uranium` and label (the FE maps it to `power`).
    note({ id: 904, segment: "uranium", segment_label: "Uran i atom", kind: "news", polarity: "positive", strength: 2, thesis_relation: "none", observed_at: "2026-09-29T07:00:00+02:00",
      title: "Kazatomprom: cięcia wydobycia 2027", summary: "Plan wydobycia na 2027 obniżony o ok. 10 %; cena spot uranu +6 % w tygodniu. Brak pozycji w temacie.",
      sources: [src("Kazatomprom", "2026-09-29", "u-1")] }),
    // P7: a watched-only topic's note (QUBT, IONQ on the watchlist).
    note({ id: 907, segment: "quantum", segment_label: "Komputery kwantowe", kind: "news", polarity: "positive", strength: 2, thesis_relation: "none", observed_at: "2026-10-03T07:00:00+02:00",
      title: "QUBT: Dirac-3S z pierwszą dostawą komercyjną", summary: "Spółka potwierdziła pierwszą dostawę komercyjną systemu; QUBT +12 % w tygodniu, IONQ +7 %. Brak pozycji w temacie.",
      sources: [src("komunikat spółki", "2026-10-02", "q-1")] }),
    // P6 macro notes (segment notes with a macro key): 905 is this week's and unread, 906 was read.
    note({ id: 905, segment: "macro_rates", segment_label: "Obligacje i stopy", kind: "macro", polarity: "neutral", strength: 2, thesis_relation: "none", observed_at: SAT,
      title: "Fed: trzecia obniżka, 10Y 3,92 %, krzywa nadal odwrócona",
      summary: "Fed obniżył stopy o 25 pb (1.10). Rentowność 10Y 3,92 % (-48 bp w 3 mies.), 3M 4,10 %: krzywa 10l-3m -18 bp. Dotyczy: obligacje, złoto.",
      sources: [src("Fed", "2026-10-01", "macro-1"), src("US Treasury", "2026-10-02", "macro-2")] }),
    note({ id: 906, segment: "macro_risk", segment_label: "Rynek akcji", kind: "macro", polarity: "positive", strength: 1, thesis_relation: "none", observed_at: "2026-09-19T07:00:00+02:00", run_id: 1,
      title: "ACWI: nowy szczyt po danych o inflacji",
      summary: "ACWI zamknął tydzień na nowym szczycie; 6,2 % nad średnią 200 sesji. CPI USA 2,6 % r/r zgodnie z oczekiwaniami.",
      sources: [src("BLS", "2026-09-17", "macro-3")] }),
    note({ candidate: { symbol: "TXT", name: "Text", exchange: "XWAR", currency: "PLN", key: "TXT" }, kind: "candidate", polarity: "neutral", strength: 2, thesis_relation: "none", observed_at: "2026-10-01T09:00:00+02:00",
      title: "Text: korekta sentymentu przy stabilnych przychodach",
      summary: "Kurs -31 % od szczytu 52 tyg. przy stabilnych przychodach od 4 kwartałów; sentyment społeczności negatywny (szum), wiadomości neutralne.",
      details: { entry_type: "sentiment_correction", context: "sentyment społeczności negatywny (szum) · wiadomości neutralne", criteria: [
        { text: "-31 % od szczytu 52 tyg.", met: true, threshold: "-25 %" }, { text: "przychody stabilne 4 kwartały", met: true }, { text: "brak w portfelu, koszyk Akcje", met: true },
      ] }, sources: [src("Bankier", "2026-10-01", "txt-1"), src("raport kwartalny", "2026-08-28", "txt-2")] }),
    note({ candidate: { symbol: "INRG", name: "Global Clean Energy", exchange: "XLON", currency: "GBP", key: "INRG" }, kind: "candidate", polarity: "positive", strength: 2, thesis_relation: "none", observed_at: SAT,
      title: "Global Clean Energy: napływy i siła relatywna",
      summary: "Napływy do ETF 5 tyg. z rzędu, siła relatywna vs ACWI +8 pp; kurs poniżej SMA 200 od 6 tygodni.",
      details: { entry_type: "trend", context: "koszyk Akcje globalne", criteria: [
        { text: "napływy do ETF 5 tyg. z rzędu", met: true }, { text: "siła relatywna vs ACWI +8 pp", met: true }, { text: "powyżej SMA 200 od 6 tyg.", met: false, threshold: "8" },
      ] }, sources: [src("ETF flows", "2026-10-03", "inrg-1"), src("justETF", "2026-10-02", "inrg-2"), src("stooq", "2026-10-03", "inrg-3")] }),
    note({ candidate: { symbol: "ACP", name: "Asseco Poland", exchange: "XWAR", currency: "PLN", key: "ACP" }, kind: "candidate", polarity: "neutral", strength: 1, thesis_relation: "none", observed_at: "2026-09-26T09:00:00+02:00", run_id: 2,
      title: "Asseco Poland: przegląd opcji strategicznych", summary: "Spółka ogłosiła przegląd opcji strategicznych.", dismissed_at: "2026-09-27T10:00:00+02:00", cooldown_until: "2026-12-26T10:00:00+01:00",
      details: { entry_type: "special_situation", context: "odrzucony: „poza kompetencjami”", criteria: [{ text: "ogłoszony przegląd opcji", met: true }] },
      sources: [src("ESPI", "2026-09-25", "acp-1")] }),
    // P1: KGHM's thesis played out (the fulfilled ring and the plan check `brak planu wyjścia`).
    // P2: stored before the last thesis edit (`sprzed zmiany tezy`; KGHM's health rests on it: the faded ring).
    note({ instrument_id: 305, instrument: kgh, kind: "earnings", polarity: "positive", strength: 2, thesis_relation: "fulfills", thesis_field: "thesis", observed_at: SAT,
      predates_thesis: true,
      title: "KGHM: marża na miedzi wróciła powyżej średniej 5 lat",
      summary: "Wyniki Q3: marża EBITDA segmentu miedzi powyżej średniej pięciu lat, czego teza „trend” oczekiwała przy wejściu.",
      sources: [src("raport kwartalny", "2026-10-02", "kgh-6")] }),
  ];
}

function janRuns(): ResearchRun[] {
  const run = (id: number, start: string, end: string | null, status: string, notes: number, signals: number, scope: string[], by = "agent", scheduled = true): ResearchRun => ({
    id, started_at: start, finished_at: end, status, interrupted: status === "failed", reason: status === "failed" ? "interrupted" : null,
    duration_s: end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null, scheduled, created_by: by, notes, signals,
    scope: { held: scope.includes("positions"), watchlist: scope.includes("watchlist"), candidates: scope.includes("candidates"), segments: scope.includes("segments") ? ["gold", "uranium"] : [], instrument_ids: scope.includes("KGH") ? [305] : [], covered_instrument_ids: [301, 304, 305, 306, 307] },
    counts: { notes, signals, candidates: notes > 5 ? 2 : 0, by_kind: { news: 3, earnings: 2, community: notes > 5 ? 3 : 0, trend: 4, macro: 2, candidate: notes > 5 ? 2 : 0 }, sources_checked: notes ? notes - 3 : 0, instruments_covered: 9 },
  });
  const all = ["positions", "watchlist", "candidates", "segments"];
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
    // F8 (Q10): agent notes of this week's run on EIMI, KGHM's community note, this week's segment notes (gold,
    // uranium) and the macro rates note (905) are unread; everything else was opened.
    for (const n of st.notes) {
      const unread = n.created_by === "agent" && n.kind !== "candidate"
        && ((n.observed_at === SAT && (n.instrument_id === 307 || (n.instrument_id === 305 && n.kind === "community"))) || n.id === 901 || n.id === 904 || n.id === 905 || n.id === 907);
      n.read_at = unread ? null : n.observed_at;
    }
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
const HEALTH: Record<number, string> = { 306: "weakened", 305: "fulfilled", 307: "weakened", 304: "no_thesis", 301: "no_thesis" }; // server wire names
const WEIGHT: Record<number, number> = { 301: 0.409, 302: 0.126, 303: 0.161, 304: 0.133, 305: 0.055, 306: 0.057, 307: 0.006 };

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
      health_rank: ["invalidated", "weakened", "fulfilled", "no_research", "no_thesis", "supported", "current"].indexOf(health),
      counts: relationCounts(mine), thesis_relation: latest?.thesis_relation ?? null, note_ids: mine.map((n) => n.id),
      fields: id === 306 ? [{ field: "thesis", supports: 1, weakens: mine.filter((n) => n.thesis_relation === "weakens").length, invalidates: 0, neutral: 0 }] : [],
      latest_polarity: latest?.polarity ?? null,
      latest_note: latest ? { id: latest.id, title: shortTitle(latest.title) ?? latest.title, kind: latest.kind, polarity: latest.polarity, thesis_relation: latest.thesis_relation, observed_at: latest.observed_at } : null,
      notes: mine.length,
      sentiment_8w: mine.length ? SENT[id] ?? sentiment8w(mine, TODAY) : sentiment8w([], TODAY),
      direction: id === 306 || id === 307 ? "falling" : "stable",
      unread: mine.filter(isUnread).length,
      health_predates_thesis: id === 305,
      last_researched_at: st.runs.filter((r) => r.status === "done").map((r) => r.finished_at).sort().slice(-1)[0] ?? null,
    };
  });
  const weekStarts = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];
  return {
    as_of: TODAY, window_days: 30, weeks: weekStarts.map((_, k) => `2026-W${33 + k}`), week_starts: weekStarts,
    last_run: [...st.runs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null, running: st.runs.some((r) => r.status === "running"),
    instruments,
    totals: { notes_active: live.length, notes_this_week: live.filter((n) => n.observed_at >= "2026-09-28").length, candidates_open: st.notes.filter((n) => n.kind === "candidate" && !n.dismissed_at).length, signals_open: 1, notes_unread: live.filter(isUnread).length },
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

// ---- market segments (P5): the attribution of the week / 4 weeks ---------------------------------------------
type SegSeed = Omit<SegmentRow, "unread">;
const SEG_1W: SegSeed[] = [
  { segment: "gold", label: "Złoto i górnicy", group: "asset", weight: 0.18, contribution: -0.008, return: -0.044,
    instruments: [{ instrument_id: 305, contribution: -0.008, return: -0.044 }],
    note: { id: 901, title: "Fed: realne stopy w dół, GDXJ -4,4 % w tygodniu", observed_at: SAT, polarity: "negative", kind: "macro", strength: 2 },
    note_this_week: true, notes_8w: 3, trend_1w: -0.044, trend_4w: -0.061, members: 2 },
  { segment: "semis_ai", label: "AI: chipy i centra danych", group: "sector", weight: 0.125, contribution: 0.004, return: 0.031,
    instruments: [{ instrument_id: 301, contribution: 0.003, return: 0.03 }, { instrument_id: 302, contribution: 0.001, return: 0.035 }],
    note: { id: 902, title: "TSMC: przychody wrzesień +30 % r/r", observed_at: addDays(TODAY, -16), polarity: "positive", kind: "news", strength: 2 },
    note_this_week: false, notes_8w: 2, trend_1w: 0.031, trend_4w: 0.082, members: 2 },
  // EDO is valued at cost: held (weight > 0) but no market move (contribution 0, return null).
  { segment: "bonds", label: "Obligacje i stopy", group: "asset", weight: 0.22, contribution: 0, return: null,
    instruments: [{ instrument_id: 303, contribution: 0, return: null }],
    note: { id: 903, title: "Rynek oczekuje stabilnych stóp procentowych", observed_at: addDays(TODAY, -9), polarity: "neutral", kind: "macro", strength: 1 },
    note_this_week: false, notes_8w: 1, trend_1w: 0.001, trend_4w: 0.004, members: 1 },
  // Its last note expired: `note` null, `last_note_at` keeps the small date.
  { segment: "equity_pl", label: "Akcje polskie", group: "asset", weight: 0.13, contribution: 0.0012, return: 0.009,
    instruments: [{ instrument_id: 304, contribution: 0.0012, return: 0.009 }], note: null, note_this_week: false, notes_8w: 0, trend_1w: 0.009, trend_4w: 0.021, members: 1 },
  { segment: "games_media", label: "Gry", group: "sector", weight: 0.06, contribution: -0.003, return: -0.05,
    instruments: [{ instrument_id: 306, contribution: -0.003, return: -0.05 }], note: null, note_this_week: false, notes_8w: 0, trend_1w: -0.05, trend_4w: -0.012, members: 1 },
  // P7: a watched-only topic (no exposure, two priced watched members).
  { segment: "quantum", label: "Komputery kwantowe", group: "sector", weight: 0, contribution: 0, return: null, instruments: [],
    note: { id: 907, title: "QUBT: Dirac-3S z pierwszą dostawą komercyjną", observed_at: addDays(TODAY, -1), polarity: "positive", kind: "news", strength: 2 },
    note_this_week: true, notes_8w: 1, trend_1w: 0.098, trend_4w: 0.31, members: 2 },
  // A note-only topic (no exposure, no priced member); the BE sends the renamed key.
  { segment: "power", label: "Energetyka: atom i OZE", group: "asset", weight: 0, contribution: 0, return: null, instruments: [],
    note: { id: 904, title: "Kazatomprom: cięcia wydobycia 2027", observed_at: addDays(TODAY, -5), polarity: "positive", kind: "news", strength: 2 },
    note_this_week: true, notes_8w: 1, trend_1w: null, trend_4w: null, members: 0 },
];
/** The segment rows with `unread` from the notes (opening a segment marks its notes read). The 4w window doubles
 * the contributions. */
function segmentRows(st: RState, window: "1w" | "4w"): SegmentRow[] {
  const k = window === "4w" ? 2 : 1;
  return SEG_1W.map((r) => ({
    ...r, contribution: r.contribution * k, return: r.return != null ? r.return * k : null,
    instruments: r.instruments.map((i) => ({ ...i, contribution: i.contribution * k, return: i.return != null ? i.return * k : null })),
    unread: st.notes.filter((n) => (n.segment === "uranium" ? "power" : n.segment) === r.segment && isUnread(n)).length,
    last_note_at: r.note?.observed_at ?? (r.segment === "equity_pl" ? addDays(TODAY, -40) : null),
  }));
}
function segmentsOf(st: RState, kind: string, window: "1w" | "4w"): SegmentAttribution {
  const k = window === "4w" ? 2 : 1;
  const start = addDays(TODAY, window === "4w" ? -28 : -7);
  if (kind !== "full") {
    return { as_of: TODAY, start, end: TODAY, window, base_currency: "PLN", portfolio_return: null, explained: 0, residual: null, new_positions: 0, stale: [], segments: [], unassigned: null, currency: { contribution: 0, currencies: [] } };
  }
  return {
    as_of: TODAY, start, end: TODAY, window, base_currency: "PLN",
    portfolio_return: -0.012 * k, explained: -0.0113 * k, residual: -0.0007 * k, new_positions: 0, stale: [307],
    segments: segmentRows(st, window),
    unassigned: { weight: 0.05, contribution: 0.001 * k, return: 0.019 * k, instruments: [{ instrument_id: 307, contribution: 0.001 * k, return: 0.019 * k, label: "EIMI", weight: 0.05 }] },
    currency: { contribution: -0.002 * k, currencies: [{ currency: "USD", weight: 0.55, return: -0.007 * k, contribution: -0.0039 * k }, { currency: "EUR", weight: 0.08, return: 0.002 * k, contribution: 0.0002 * k }] },
  };
}

// ---- macro regimes (P6): five cards, one stale, one inverted curve, one change this week -------------------
// Shaped like the BE (`macro/service.py`): top-level `as_of` = the last bar, `flags` on every card, history items
// with `state_label` (the first run of the stored window is `open`), `since_open` / `since_min` for a state that
// held since before the window, a missing card with the BE meaning and `stale`.
const MACRO_AS_OF = "2026-10-02"; // Friday's session = the last bar
const MACRO_WINDOW = "2025-03-10"; // first evaluated session of the stored window
const MACRO_MISSING = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("macro") === "missing";
type RegimeSeed = Omit<MacroRegime, "unread" | "note_this_week"> & { flags: string[] };
const hist = (key: string, items: [string, string, boolean?][]) => items.map(([date, state, open]) => ({ date, state, state_label: stateLabel(key, state), ...(open ? { open: true } : {}) }));
const MACRO_SEED: RegimeSeed[] = [
  { key: "risk", label: "Rynek akcji", state: "bull", state_label: "hossa", tone: "pos", since: "2026-08-14", since_open: false, since_min: MACRO_WINDOW, as_of: MACRO_AS_OF, stale: false, missing: false, flags: [],
    meaning: "Globalne akcje są powyżej rosnącej średniej z 200 sesji: trwały trend wzrostowy szerokiego rynku.",
    summary: "Akcje na świecie rosną od sierpnia, są 1,4 % pod szczytem.",
    explain: "Hossa to okres, w którym szeroki rynek akcji rośnie przez wiele miesięcy, bessa to spadek o ponad 20 % od szczytu, korekta to spadek o 10-20 %. Aplikacja patrzy na globalny indeks ACWI: hossa, gdy jest powyżej rosnącej średniej z 200 sesji i blisko szczytu. Od 14.08 indeks jest nad średnią, 1,4 % pod szczytem. W takich okresach spadki o kilka procent zwykle były przejściowe.",
    metrics: [{ label: "ACWI wobec 200 sesji", value: 0.062, unit: "pct", text: "+6,2 %" }, { label: "od szczytu", value: -0.014, unit: "pct", text: "-1,4 %" }, { label: "S&P 500 od szczytu", value: -0.008, unit: "pct", text: "-0,8 %" }],
    history: hist("risk", [[MACRO_WINDOW, "correction", true], ["2025-05-02", "flat"], ["2025-06-20", "bull"], ["2026-04-07", "weak"], ["2026-08-14", "bull"]]),
    note: { id: 906, title: "ACWI: nowy szczyt po danych o inflacji", observed_at: "2026-09-19T07:00:00+02:00", polarity: "positive", kind: "macro" }, last_note_at: "2026-09-19T07:00:00+02:00" },
  { key: "dollar", label: "Dolar", state: "weak", state_label: "słabnie", tone: "", since: "2026-10-02", since_open: false, since_min: MACRO_WINDOW, as_of: MACRO_AS_OF, stale: false, missing: false, flags: [],
    meaning: "Słabnący dolar obniża wartość aktywów w USD liczoną w złotych i zwykle sprzyja rynkom wschodzącym i surowcom.",
    summary: "Dolar słabnie od października; w tym tygodniu USD/PLN -0,6 %, co odjęło portfelowi 0,3 pp.",
    explain: "Cykl dolarowy to wieloletnie fale umocnienia i osłabienia USD wobec koszyka walut. Aplikacja patrzy na indeks DXY wobec jego średniej z 200 sesji i na zmianę z 6 miesięcy. Słaby dolar obniżał dotąd wartość aktywów w USD liczoną w złotych i zwykle sprzyjał rynkom wschodzącym i surowcom.",
    metrics: [{ label: "DXY", value: 98.4, unit: "level", text: "98,4" }, { label: "6 mies.", value: -0.048, unit: "pct", text: "-4,8 %" }, { label: "USD/PLN 6 mies.", value: -0.051, unit: "pct", text: "-5,1 %", stale: true }],
    history: hist("dollar", [[MACRO_WINDOW, "weak", true], ["2025-11-03", "flat"], ["2026-10-02", "weak"]]),
    note: null, last_note_at: null },
  MACRO_MISSING
    ? { key: "em", label: "Rynki wschodzące", state: "unknown", state_label: "brak danych", tone: "", since: null, since_open: false, since_min: null, as_of: "2026-09-18", stale: true, missing: true, flags: [],
      meaning: "Za mało aktualnych notowań, by ustalić stan.", summary: null, explain: null, metrics: [], history: [], note: null, last_note_at: null }
    : { key: "em", label: "Rynki wschodzące", state: "inline", state_label: "w linii", tone: "", since: null, since_open: true, since_min: MACRO_WINDOW, as_of: MACRO_AS_OF, stale: false, missing: false, flags: [],
      meaning: "Akcje rynków wschodzących radzą sobie od pół roku podobnie jak akcje globalne.",
      summary: "Rynki wschodzące idą równo ze światem od ponad roku.",
      explain: "Rynki wschodzące (Chiny, Indie, Brazylia, Tajwan i inne) mają własne cykle, często związane z dolarem i surowcami. Aplikacja porównuje wynik ETF EEM z globalnym ACWI z ostatnich 6 miesięcy: różnica ponad 5 pp to przewaga jednej strony. Teraz różnica jest mała, więc oba rynki idą podobnie.",
      metrics: [{ label: "EEM wobec ACWI 6 mies.", value: 1.9, unit: "pp", text: "+1,9 pp" }, { label: "EEM 6 mies.", value: 0.093, unit: "pct", text: "+9,3 %" }],
      history: hist("em", [[MACRO_WINDOW, "inline", true]]), note: null, last_note_at: null },
  { key: "commodities", label: "Surowce", state: "flat", state_label: "bez trendu", tone: "", since: "2026-07-21", since_open: false, since_min: MACRO_WINDOW, as_of: "2026-09-26", stale: true, missing: false, flags: [],
    meaning: "Szeroki koszyk surowców nie ma wyraźnego trendu: to ani hossa, ani bessa surowcowa.",
    summary: "Surowce bez wyraźnego trendu od lipca: +4 % w rok, słabiej niż akcje.",
    explain: "Supercykl surowcowy to wieloletni okres drożenia ropy, metali i żywności, zwykle przy silnym popycie i słabym dolarze. Aplikacja patrzy na koszyk DBC: zmianę z 12 miesięcy i wynik wobec akcji globalnych. Koszyk zyskał 4 % w rok, wyraźnie mniej niż akcje, więc nie jest to ani hossa, ani bessa surowcowa.",
    metrics: [{ label: "DBC 12 mies.", value: 0.041, unit: "pct", text: "+4,1 %" }, { label: "wobec ACWI 12 mies.", value: -6.2, unit: "pp", text: "-6,2 pp" }],
    history: hist("commodities", [[MACRO_WINDOW, "bull", true], ["2026-07-21", "flat"]]),
    note: null, last_note_at: "2026-09-12T07:00:00+02:00" },
  { key: "rates", label: "Obligacje i stopy", state: "falling", state_label: "rentowności spadają · krzywa odwrócona", tone: "warn", since: "2026-09-05", since_open: false, since_min: MACRO_WINDOW, as_of: MACRO_AS_OF, stale: false, missing: false, flags: ["inverted"],
    meaning: "Niższe rentowności obniżają koszt pieniądza: zwykle sprzyjają wycenom spółek wzrostowych i cenom obligacji długoterminowych.",
    summary: "Rentowności w USA spadają od września, krzywa wciąż odwrócona.",
    explain: "Rentowność obligacji to roczny zysk z ich trzymania; gdy spada, ceny obligacji rosły. Krzywa dochodowości porównuje obligacje 10-letnie z 3-miesięcznymi: odwrócona (krótkie wyżej niż długie) w przeszłości często poprzedzała spowolnienie gospodarki. Aplikacja patrzy na zmianę rentowności 10-letnich z 3 miesięcy. Od 5.09 rentowności spadają, a krzywa pozostaje odwrócona.",
    metrics: [{ label: "USA 10 lat", value: 3.92, unit: "level", text: "3,92 %" }, { label: "3 mies. zmiana", value: -48, unit: "bp", text: "-48 bp" }, { label: "krzywa 10l-3m", value: -18, unit: "bp", text: "-18 bp" }],
    history: hist("rates", [[MACRO_WINDOW, "stable", true], ["2025-11-11", "rising"], ["2026-03-02", "stable"], ["2026-09-05", "falling"]]),
    note: { id: 905, title: "Fed: trzecia obniżka, 10Y 3,92 %, krzywa nadal odwrócona", observed_at: SAT, polarity: "neutral", kind: "macro" }, last_note_at: SAT },
];
/** The regimes with `unread` / `note_this_week` from the notes (opening a card marks its notes read). */
function macroOf(st: RState, kind: string): MacroRegimes {
  if (kind !== "full") return { as_of: null, regimes: [] };
  return {
    as_of: MACRO_AS_OF, regimes: MACRO_SEED.map((r) => ({
      ...r, note_this_week: !!r.note && r.note.observed_at.slice(0, 10) >= "2026-09-28",
      unread: st.notes.filter((n) => n.segment === `macro_${r.key}` && isUnread(n)).length,
    })),
  };
}

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
  const since = "2026-09-27";
  // The dollar's change of 2.10 falls inside the period starting 27.09; the rates change of 5.09 does not.
  const macro_changes = kind === "full" ? [{ key: "dollar", label: "Dolar", from_label: "bez trendu", to_label: "słabnie", since: "2026-10-02" }] : [];
  // Like the BE: the block exists before the first run too (run null), the macro changes do not depend on runs.
  if (!st.runs.length) return { since, run: null, ran_in_period: false, notes_count: 0, theses_changed: [], candidates: [], macro_changes };
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
    // The top 4 plus the watched-only quantum row (the review shows a muted topic).
    segments: [...segmentRows(st, "1w").slice(0, 4), ...segmentRows(st, "1w").filter((r) => r.segment === "quantum")],
    market: (({ segments: _s, ...rest }) => rest)(segmentsOf(st, kind, "1w")),
    macro_changes,
    candidates: fresh.filter((n) => n.kind === "candidate").map((n) => n.id),
  };
}

// ---- router ---------------------------------------------------------------------------------------------
/** Server-computed note fields (RS CONTRACT 2). */
const isUnread = (n: ResearchNote) => n.read_at == null && !n.dismissed_at && n.created_by === "agent" && n.kind !== "candidate" && !(!!n.expires_at && n.expires_at.slice(0, 10) < TODAY);
/** Unread agent notes of an instrument (positions / watchlist `research_unread`, F8 BE C2). */
export function researchUnread(slug: string, kind: string, instrumentId: number): number {
  return stateFor(slug, kind).notes.filter((n) => n.instrument_id === instrumentId && isUnread(n)).length;
}
function decorate(n: ResearchNote): ResearchNote {
  const expired = !!n.expires_at && n.expires_at.slice(0, 10) < TODAY;
  return {
    ...n, expired, read_at: n.read_at ?? null, unread: isUnread(n), dismissed: !!n.dismissed_at, restorable_until: n.dismissed_at ? new Date(Date.parse(n.dismissed_at) + 15 * 60000).toISOString() : null,
    held: n.instrument_id != null && n.instrument_id < 400, watched: !!n.candidate?.accepted_at,
  };
}
export interface WatchHooks { add: (symbol: string, name: string, note: string) => number; remove: (id: number) => void }

export function researchMock(slug: string, kind: string, ip: string, q: URLSearchParams, method: string, body: unknown, watch: WatchHooks): unknown {
  const st = stateFor(slug, kind);
  const b = (body ?? {}) as Record<string, unknown>;
  if (ip === "/research/runs") return st.runs;
  if (ip === "/research/summary") return summary(st);
  if (ip === "/research/segments") {
    const w = q.get("window") ?? "1w";
    if (w !== "1w" && w !== "4w") throw new ApiError(422, "window must be 1w or 4w");
    return segmentsOf(st, kind, w);
  }
  if (ip === "/research/macro") return macroOf(st, kind);
  if (ip === "/research/read" && method === "POST") {
    const hit = (n: ResearchNote) => (b.instrument_id != null ? n.instrument_id === Number(b.instrument_id) : typeof b.segment === "string" ? n.segment === b.segment : Array.isArray(b.ids) ? (b.ids as number[]).includes(n.id) : false);
    let marked = 0;
    for (const n of st.notes) if (hit(n) && isUnread(n)) { n.read_at = new Date().toISOString(); marked++; }
    return { marked };
  }
  if (ip === "/research" && method === "GET") {
    const instrument = q.get("instrument"), theme = q.get("theme"), segment = q.get("segment"), k = q.get("kind"), since = q.get("since");
    const withDismissed = q.get("include_dismissed") === "true", withExpired = q.get("include_expired") === "true";
    return st.notes.map(decorate)
      .filter((n) => (instrument == null || String(n.instrument_id) === instrument) && (!theme || n.theme === theme) && (!segment || n.segment === segment) && (!k || k.split(",").includes(n.kind)) && (!since || n.observed_at >= since)
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
