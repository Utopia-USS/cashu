// Polish labels for backend messages that carry a stable code: strategy issues (`code` + `params`
// from strategy/codes.py), import warnings (`import.<kind>`), agent proposal summaries
// (`summary_code` = the kind + `summary_params`) and proposal errors (`result.error_code`).
// The server text stays English; an unknown code, or a template whose params are missing, falls back
// to that English text. Pure module (no React, no DOM): tested in tests/messages.test.mjs, and the
// backend test tests/test_message_codes.py checks that every backend code has a label here. Also the
// performance data-quality notes (`perf.<code>`) and worker job outcomes (`worker.<code>`).

import { serverDate } from "../time.ts";

export type Params = Record<string, unknown>;
/** A template ("{key}" placeholders) or a function; null from a function = fall back to English. */
type Label = string | ((p: Params) => string | null);

const q = (v: unknown) => `„${String(v)}"`;
const hint = (p: Params) => (p.suggestion ? ` (czy chodziło o ${q(p.suggestion)}?)` : "");
/** Values the server describes in English (`got a mapping`); a quoted text value gets Polish quotes. */
const val = (v: unknown) =>
  ({ "a mapping": "mapą", "a list": "listą", true: "true", false: "false" } as Record<string, string>)[String(v)]
  ?? String(v).replace(/^"(.*)"$/s, (_m, t: string) => q(t));
const range = (r: unknown) =>
  String(r)
    .replace(/greater than/g, "większe niż")
    .replace(/at least/g, "co najmniej")
    .replace(/less than/g, "mniejsze niż")
    .replace(/at most/g, "co najwyżej")
    .replace(/ and /g, " i ");
const has = (p: Params, ...keys: string[]) => keys.every((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");
const CUR_SIGN: Record<string, string> = { PLN: "zł", EUR: "€", USD: "$", GBP: "£", CHF: "CHF" };
/** Decimal text or a number as "148,60 zł" (2 decimals, Polish grouping); no currency = the number only. */
const cur = (v: unknown, c?: unknown) => {
  const n = Number(v);
  const txt = Number.isFinite(n) ? n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  return c ? `${txt} ${CUR_SIGN[String(c)] ?? String(c)}` : txt;
};
/** A fraction as a percent with one decimal: 0.124 -> "12,4 %". */
const frac = (v: unknown) => {
  const n = Math.abs(Number(v)) * 100;
  return Number.isFinite(n) ? `${n.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} %` : String(v);
};

/** "2026-10-05" -> "05.10.2026" (dates in params are calendar days). */
const dmyText = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v);
};
/** A server datetime in params -> "5.10 14:30" in local time (time.ts reads a missing offset as UTC). */
const whenText = (v: unknown) => {
  const t = serverDate(String(v));
  return t ? `${t.getDate()}.${String(t.getMonth() + 1).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : String(v);
};

/** Polish plural: plural(5, "reguła", "reguły", "reguł") -> "5 reguł". */
export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10, n100 = n % 100;
  const w = n === 1 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${w}`;
}

// ---- English sentences inside params: a custom rule's condition error (`strategy.expression_invalid`
// {detail}, from rules/expr lexer.py / parser.py / checker.py) and the YAML parser's problem
// (`strategy.yaml_invalid` {problem}, PyYAML). Each pattern matches one whole sentence; a sentence no pattern
// knows is dropped (the label keeps its Polish part and the UI its line), never shown in English.
type Sentence = [RegExp, (m: string[]) => string | null];
const ART: Record<string, [string, string]> = { "a number": ["liczbą", "liczbę"], "a condition (true/false)": ["warunkiem", "warunek"], text: ["tekstem", "tekst"] };
const A = String.raw`(a number|a condition \(true/false\)|text)`;
const HINT = String.raw`(?: \(did you mean "([^"]*)"\?\))?`;
const RANGE = String.raw`(?: between (\S+) and (\S+)| of at least (\S+))?`;
const dym = (s?: string) => (s ? ` (czy chodziło o ${q(s)}?)` : "");
const rangePl = (a?: string, b?: string, c?: string) => (a ? ` od ${a} do ${b}` : c ? ` co najmniej ${c}` : "");
/** An expression part the checker names: a metric, a number, "text", or "the part at column N". */
const shown = (s: string) => {
  const col = /^the part at column (\d+)$/.exec(s);
  return col ? `część z kolumny ${col[1]}` : s.replace(/^"(.*)"$/, (_m, t: string) => q(t));
};
const token = (s: string) => (s === "the end of the expression" ? "koniec warunku" : s);
const NEEDS: Record<string, string> = { "a condition": "warunku", "a number": "liczby", "numbers on both sides": "liczb po obu stronach", "conditions on both sides": "warunków po obu stronach" };
const rx = (src: string, f: Sentence[1]): Sentence => [new RegExp(`^${src}$`), f];

const EXPR_FIXED: Record<string, string> = {
  "Powers are not supported": "potęgowanie nie jest obsługiwane",
  "Integer division is not supported; use '/'": "dzielenie całkowite nie jest obsługiwane; użyj '/'",
  "Use '!=' to compare for inequality": "użyj '!=' (różne od)",
  "Use '>=' for 'greater than or equal'": "użyj '>=' (większe lub równe)",
  "Use '<=' for 'less than or equal'": "użyj '<=' (mniejsze lub równe)",
  "Use '==' to compare; assignment is not supported": "do porównania użyj '=='; przypisanie nie jest obsługiwane",
  "'%' must directly follow a number (5% = 0.05); the modulo operator is not supported": "'%' musi stać tuż za liczbą (5% = 0.05); modulo nie jest obsługiwane",
  "Attribute access is not supported": "odwołania przez kropkę nie są obsługiwane",
  "Indexing and lists are not supported": "indeksy i listy nie są obsługiwane",
  "Braces are not supported": "nawiasy klamrowe nie są obsługiwane",
  "Powers and bit operations are not supported": "potęgi i operacje bitowe nie są obsługiwane",
  "Bit operations are not supported": "operacje bitowe nie są obsługiwane",
  "The '@' operator is not supported": "operator '@' nie jest obsługiwany",
  "Only one expression is allowed; ';' is not supported": "dozwolony jest jeden warunek; ';' nie jest obsługiwane",
  "Backslashes are not supported": "znak '\\' nie jest obsługiwany",
  "Comments are not supported": "komentarze nie są obsługiwane",
  "Backticks are not supported": "znak '`' nie jest obsługiwany",
  "A decimal point must be followed by digits (e.g. 0.5)": "po kropce dziesiętnej muszą być cyfry (np. 0.5)",
  "A number can have only one decimal point": "liczba może mieć tylko jedną kropkę",
  "Scientific notation is not supported; write the number out": "zapis wykładniczy nie jest obsługiwany; wpisz pełną liczbę",
  "Text must end on the same line (missing closing quote)": "tekst musi kończyć się w tej samej linii (brak cudzysłowu zamykającego)",
  "Backslash escapes are not supported in text": "znak '\\' w tekście nie jest obsługiwany",
  "Expression is empty": "warunek jest pusty",
  "Chained comparisons are not supported; combine them with 'and'": "porównania łańcuchowe nie są obsługiwane; połącz je przez 'and'",
  "'not' must be put in parentheses here, e.g. 1 + (not x)": "tu 'not' musi być w nawiasie, np. 1 + (not x)",
  "Expression ended unexpectedly; expected a value": "warunek urywa się; brakuje wartości",
  "The expression uses no metric, so it would always give the same answer": "warunek nie używa żadnej metryki, więc zawsze da ten sam wynik",
};
const EXPR_RX: Sentence[] = [
  rx(String.raw`'(.)' is not supported`, (m) => `znak '${m[1]}' nie jest obsługiwany`),
  rx(String.raw`Use '(.+)' instead of '(.+)'`, (m) => `użyj '${m[1]}' zamiast '${m[2]}'`),
  rx(String.raw`Expression is too long \((\d+) characters, max (\d+)\)`, (m) => `warunek za długi (${m[1]} znaków, maks. ${m[2]})`),
  rx(String.raw`Expression has too many parts \(max (\d+) tokens\)`, (m) => `warunek ma za dużo elementów (maks. ${m[1]})`),
  rx(String.raw`Expression is nested too deeply \(max (\d+) levels\)`, (m) => `warunek zagnieżdżony zbyt głęboko (maks. ${m[1]} poziomów)`),
  rx("Unexpected character (.+) in text", (m) => `niedozwolony znak ${m[1]} w tekście`),
  rx("Unexpected character (.+)", (m) => `niedozwolony znak ${m[1]}`),
  rx(String.raw`(Number|Name|Text) is too long \(max (\d+) characters\)`, (m) => `${{ Number: "liczba", Name: "nazwa", Text: "tekst" }[m[1]]} za ${m[1] === "Text" ? "długi" : "długa"} (maks. ${m[2]} znaków)`),
  rx('Invalid number "(.*)"', (m) => `nieprawidłowa liczba ${q(m[1])}`),
  rx(String.raw`Names cannot start with "_" \(got "(.*)"\)`, (m) => `nazwa nie może zaczynać się od "_" (${q(m[1])})`),
  rx("Missing closing quote (.)", (m) => `brak cudzysłowu zamykającego ${m[1]}`),
  rx("Unexpected (.+) after a complete expression", (m) => `nadmiarowe ${token(m[1])} po pełnym warunku`),
  rx(String.raw`Missing '\)' for the '\(' at column (\d+); found (.+)`, (m) => `brak ')' do '(' z kolumny ${m[1]}; jest ${token(m[2])}`),
  rx(String.raw`Missing '\)' to close (\S+)\( at column (\d+); found (.+)`, (m) => `brak ')' zamykającego ${m[1]}( z kolumny ${m[2]}; jest ${token(m[3])}`),
  rx("Expected a value, found (.+)", (m) => `brakuje wartości, jest ${token(m[1])}`),
  rx(String.raw`Too many arguments for (\S+?)(?: \(max (\d+)\))?`, (m) => `za dużo argumentów w ${m[1]}${m[2] ? ` (maks. ${m[2]})` : ""}`),
  rx(String.raw`The expression must be a condition \(true or false\), e\.g\. weight > 10%; this one gives ${A}`,
    (m) => `warunek musi dawać prawdę albo fałsz, np. weight > 10%; ten daje ${ART[m[1]][1]}`),
  rx(`'(.+?)' needs (${Object.keys(NEEDS).join("|")}); (.+) is ${A}`, (m) => `'${m[1]}' wymaga ${NEEDS[m[2]]}; ${shown(m[3])} jest ${ART[m[4]][0]}`),
  rx(`'(.+?)' compares values of the same type; (.+) is ${A}, (.+) is ${A}`,
    (m) => `'${m[1]}' porównuje wartości tego samego typu; ${shown(m[2])} jest ${ART[m[3]][0]}, ${shown(m[4])} jest ${ART[m[5]][0]}`),
  rx(`'(.+?)' compares numbers; (.+) is ${A}`, (m) => `'${m[1]}' porównuje liczby; ${shown(m[2])} jest ${ART[m[3]][0]}`),
  rx('Write "(.+)" in lowercase', (m) => `pisz ${q(m[1])} małymi literami`),
  rx(`Unknown name "([^"]*)"${HINT}; see the metric catalog for scope (\\w+)`, (m) => `nieznana nazwa ${q(m[1])}${dym(m[2])} w scope ${m[3]}`),
  rx(String.raw`(\S+) is not available in scope (\w+) \(available in: (.+)\)`, (m) => `${m[1]} nie działa w scope ${m[2]} (działa w: ${m[3]})`),
  rx("(\\S+) is a function; call it with arguments: (.+)", (m) => `${m[1]} to funkcja; użycie: ${m[2]}`),
  rx("(\\S+) is not a function; write it without parentheses", (m) => `${m[1]} to nie funkcja; zapisz bez nawiasów`),
  rx(String.raw`(\S+) takes (?:(at least )?(\d+) argument\(s\)|no arguments); usage: (.+)`,
    (m) => `${m[1]}: zła liczba argumentów (${m[3] ? `${m[2] ? "co najmniej " : ""}${m[3]}` : "0"}); użycie: ${m[4]}`),
  rx("(\\S+) lists the same value twice", (m) => `${m[1]}: ta sama wartość dwa razy`),
  rx(`(\\S+) of (\\S+) must be a whole number${RANGE}, written as a literal`,
    (m) => `${m[1]} w ${m[2]} musi być liczbą całkowitą${rangePl(m[3], m[4], m[5])} wpisaną wprost`),
  rx("(\\S+) of (\\S+) must be a whole number, got (.+)", (m) => `${m[1]} w ${m[2]} musi być liczbą całkowitą, jest ${m[3]}`),
  rx(`(\\S+) of (\\S+) must be${RANGE}, got (.+)`, (m) => `${m[1]} w ${m[2]} musi być${rangePl(m[3], m[4], m[5])}, jest ${m[6]}`),
  rx("(\\S+) of (\\S+) must be text in quotes, e\\.g\\. (.+)", (m) => `${m[1]} w ${m[2]} musi być tekstem w cudzysłowie, np. ${m[3]}`),
  rx("(\\S+) of (\\S+) must not be empty", (m) => `${m[1]} w ${m[2]} nie może być puste`),
  rx(`Unknown (\\S+) "([^"]*)"${HINT}; known: (.+)`, (m) => `nieznana wartość ${q(m[2])} dla ${m[1]}${dym(m[3])}; dostępne: ${m[4]}`),
  rx(`(\\S+) is never "([^"]*)"${HINT}; known: (.+)`, (m) => `${m[1]} nigdy nie jest ${q(m[2])}${dym(m[3])}; dostępne: ${m[4]}`),
];
/** PyYAML problems (the "(while parsing ...)" context is dropped). */
const YAML_FIXED: Record<string, string> = {
  "mapping values are not allowed here": "dwukropek w złym miejscu (sprawdź wcięcia i cudzysłowy)",
  "could not find expected ':'": "brak dwukropka po kluczu",
  "found unexpected end of stream": "plik urywa się (niezamknięty cudzysłów?)",
  "sequence entries are not allowed here": "element listy (-) w złym miejscu",
  "mapping keys are not allowed here": "klucz w złym miejscu",
  "invalid indentation or unclosed '[' or '{'": "złe wcięcie albo niezamknięty '[' lub '{'",
  "but found another document": "więcej niż jeden dokument (---)",
  "found unexpected document separator": "nieoczekiwany separator dokumentu (---)",
};
const YAML_RX: Sentence[] = [
  rx("found character '\\\\t' that cannot start any token", () => "tabulator zamiast spacji we wcięciu"),
  rx("found character (.+) that cannot start any token", (m) => `znak ${m[1]} nie może tu stać`),
  rx("expected <block end>, but found (.+)", () => "złe wcięcie"),
  rx("expected ',' or '\\]', but got (.+)", () => "niezamknięta lista: brak ',' albo ']'"),
  rx("expected ',' or '\\}', but got (.+)", () => "niezamknięta mapa: brak ',' albo '}'"),
  rx("expected the node content, but found (.+)", () => "brak wartości"),
  rx("found unknown escape character (.+)", (m) => `nieznany znak po '\\': ${m[1]}`),
];
function sentence(text: unknown, fixed: Record<string, string>, patterns: Sentence[]): string | null {
  const s = String(text ?? "");
  if (Object.prototype.hasOwnProperty.call(fixed, s)) return fixed[s];
  for (const [re, f] of patterns) {
    const m = re.exec(s);
    if (m) return f(Array.from(m, (g) => g ?? ""));
  }
  return null;
}
/** The Polish form of a condition error's English `detail`, or null for an unknown sentence. */
export const exprDetail = (detail: unknown) => sentence(detail, EXPR_FIXED, EXPR_RX);
/** The Polish form of a PyYAML problem (its "(while ...)" / "(expected ...)" context dropped), or null. */
export const yamlProblem = (problem: unknown) =>
  sentence(String(problem ?? "").replace(/ \((?:while|expected) [^()]*\)$/, ""), YAML_FIXED, YAML_RX);

const ID_WHAT: Record<string, string> = { Bucket: "koszyka", Rule: "reguły", Benchmark: "benchmarku", bucket: "koszyka", rule: "reguły" };

export const LABELS: Record<string, Label> = {
  // ---- strategy.yaml: the document --------------------------------------------------------------
  "strategy.yaml_too_large": "Plik strategy.yaml jest za duży ({chars} znaków, maks. {max})",
  "strategy.yaml_duplicate_key": "Błędny YAML: klucz „{key}\" się powtarza (pierwszy raz w linii {first_line})",
  "strategy.yaml_too_deep": "Plik strategy.yaml jest zagnieżdżony zbyt głęboko",
  "strategy.yaml_invalid": (p) => { const pl = yamlProblem(p.problem); return pl ? `Błędny YAML: ${pl}` : "Błędny YAML"; },
  "strategy.yaml_alias": "Kotwice i aliasy YAML (& i *) nie są obsługiwane",
  "strategy.yaml_merge_key": "Klucze scalania YAML (<<) nie są obsługiwane",
  "strategy.yaml_tag": "Nieobsługiwany tag YAML {tag}",
  "strategy.yaml_key_not_text": "Klucze w YAML muszą być zwykłym tekstem",
  "strategy.empty": "Plik strategy.yaml jest pusty; potrzebuje co najmniej version i base_currency",
  "strategy.not_mapping": "strategy.yaml musi być mapą kluczy (version, base_currency, ...)",
  "strategy.md_empty": "Plik strategy.md jest pusty: zapisz w nim cele",
  // ---- header -----------------------------------------------------------------------------------
  "strategy.version_unsupported": "Nieobsługiwana wersja {version} (obsługiwane: {supported})",
  "strategy.base_currency_required": "Brak base_currency (np. PLN)",
  "strategy.currency_invalid": "„{value}\" nie jest trzyliterowym kodem waluty ISO",
  "strategy.base_currency_not_pln": "Tylko PLN jest w pełni obsługiwany jako waluta bazowa (kursy NBP są w PLN)",
  // ---- buckets ----------------------------------------------------------------------------------
  "strategy.buckets_not_list": "buckets musi być listą wpisów z id i match",
  "strategy.bucket_not_mapping": "Każdy koszyk musi być mapą z id i match",
  "strategy.bucket_id_required": "Brak id koszyka",
  "strategy.id_invalid": (p) => has(p, "what", "id") ? `Id ${ID_WHAT[String(p.what)] ?? String(p.what)} ${q(p.id)} może zawierać tylko litery, cyfry, "_", "." i "-"` : null,
  "strategy.id_duplicate": (p) => has(p, "what", "id", "first_line") ? `Powtórzone id ${ID_WHAT[String(p.what)] ?? String(p.what)} ${q(p.id)} (pierwszy raz w linii ${p.first_line})` : null,
  "strategy.match_required": "Brak match (dla koszyka na wszystko wpisz match: {})",
  "strategy.bucket_catch_all": "Koszyk „{bucket}\" pasuje do każdego instrumentu, więc koszyki po nim nigdy nie pasują",
  "strategy.no_cash_bucket": "Żaden koszyk nie obejmuje asset_class: cash, więc gotówka zostaje nieprzypisana",
  // ---- allocation -------------------------------------------------------------------------------
  "strategy.targets_missing": "Są koszyki, ale brakuje allocation.targets",
  "strategy.allocation_not_mapping": "allocation musi być mapą z targets i rebalance",
  "strategy.targets_required": "Brak allocation.targets (id koszyka -> waga, suma 1)",
  "strategy.targets_not_mapping": "allocation.targets musi być mapą: id koszyka -> waga",
  "strategy.target_unknown_bucket": (p) => has(p, "bucket") ? `Cel wskazuje nieistniejący koszyk ${q(p.bucket)}${hint(p)}` : null,
  "strategy.target_invalid": "Cel koszyka {bucket} musi być liczbą od 0 do 1 (0.6 = 60%), jest {value}",
  "strategy.targets_sum": "Cele sumują się do {sum}, a powinny do 1",
  "strategy.target_missing": "Koszyk „{bucket}\" nie ma celu w allocation.targets; liczony jako 0",
  // ---- rules ------------------------------------------------------------------------------------
  "strategy.rules_not_list": "rules musi być listą wpisów z id, kind i params",
  "strategy.rule_not_mapping": "Każda reguła musi być mapą z id, kind i opcjonalnym params",
  "strategy.rule_id_required": "Brak id reguły",
  "strategy.rule_kind_required": "Brak rodzaju reguły (kind); dostępne: {known}",
  "strategy.rule_kind_unknown": (p) => has(p, "kind", "known") ? `Nieznany rodzaj reguły ${q(p.kind)}${hint(p)}; dostępne: ${p.known}` : null,
  "strategy.params_not_mapping": "params musi być mapą",
  "strategy.rebalance_without_drift": "Pasma rebalansowania sprawdza tylko reguła allocation_drift; dodaj ją do rules",
  "strategy.drift_needs_targets": "allocation_drift wymaga koszyków i allocation.targets",
  "strategy.custom_bucket_needs_targets": "Reguły custom ze scope bucket wymagają koszyków i allocation.targets",
  "strategy.unknown_bucket": (p) => has(p, "bucket") ? `Nieznany koszyk ${q(p.bucket)}${hint(p)}${p.column ? ` (kolumna ${p.column} warunku)` : ""}` : null,
  "strategy.contribution_gap_needs_plan": "contribution_gap wymaga planu contributions; bez niego reguła jest zawsze pomijana",
  "strategy.when_required": "Brak when: warunku, np. „weight > 10%\"",
  "strategy.expression_invalid": (p) => { const pl = exprDetail(p.detail); return has(p, "column") ? `Błąd w warunku (kolumna ${p.column})${pl ? `: ${pl}` : ""}` : null; },
  "strategy.message_empty": "message nie może być puste",
  "strategy.message_too_long": "message musi być jedną linią, maks. {max} znaków",
  "strategy.scope_only": "{key} dotyczy tylko scope {scope}",
  "strategy.tags_required": "Brak tags (jeden tag albo lista)",
  "strategy.cash_level_needs_bound": "cash_level wymaga min_weight, max_weight albo obu",
  "strategy.min_below_max": "{key} musi być mniejsze niż {other}",
  // ---- benchmark, notifications, watchlist ------------------------------------------------------
  "strategy.benchmark_id_required": "Brak benchmark.id (np. msci_acwi)",
  "strategy.benchmark_proxy_required": "Brak benchmark.proxy: symbol Yahoo albo ISIN instrumentu, który odwzorowuje benchmark",
  "strategy.benchmark_proxy_empty": "benchmark.proxy nie może być puste",
  "strategy.benchmark_one_currency": "benchmark.currency musi być jednym kodem waluty",
  "strategy.unknown_choice": (p) => has(p, "what", "value", "allowed") ? `Nieznany ${p.what === "weekday" ? "dzień tygodnia" : "poziom"} ${q(p.value)}${hint(p)}; dozwolone: ${p.allowed}` : null,
  "strategy.watchlist_not_mapping": "watchlist musi być mapą z criteria",
  "strategy.criteria_not_mapping": "watchlist.criteria musi być mapą: kryterium -> liczba",
  "strategy.criterion_unknown": (p) => has(p, "key") ? `Nieznane kryterium ${q(p.key)}${hint(p)}; zostaje na później` : null,
  // ---- generic param problems -------------------------------------------------------------------
  "strategy.unknown_key": (p) => has(p, "key") ? `Nieznany klucz ${q(p.key)}${hint(p)}; jest pomijany` : null,
  "strategy.unknown_asset_class": (p) => has(p, "value", "allowed") ? `Nieznana klasa aktywów ${q(p.value)}${hint(p)}; dostępne: ${p.allowed}` : null,
  "strategy.unknown_value": (p) => has(p, "value", "key", "allowed") ? `Nieznana wartość ${q(p.value)} dla ${p.key}${hint(p)}; dozwolone: ${p.allowed}` : null,
  "strategy.required": "Brak {key}",
  "strategy.not_number": (p) => has(p, "key", "value") ? `${p.key} musi być liczbą, jest ${val(p.value)}` : null,
  "strategy.not_whole_number": (p) => has(p, "key", "value") ? `${p.key} musi być liczbą całkowitą, jest ${val(p.value)}` : null,
  "strategy.not_finite": "{key} musi być skończoną liczbą",
  "strategy.not_text_list": (p) => has(p, "key", "value") ? `${p.key} musi być tekstem albo listą tekstów, jest ${val(p.value)}` : null,
  "strategy.not_text": (p) => has(p, "key", "value") ? `${p.key} musi być tekstem, jest ${val(p.value)}` : null,
  "strategy.not_mapping_key": "{key} musi być mapą",
  "strategy.out_of_range": (p) => has(p, "key", "range", "value") ? `${p.key} musi być ${range(p.range)}, jest ${p.value}${p.fraction_hint ? " (ułamki: 0.15 = 15%)" : ""}` : null,

  // ---- import warnings (kind; the English detail is shown next to the label) ---------------------
  "import.file_format": "Nieobsługiwany lub uszkodzony plik",
  "import.missing_column": "Brak kolumny w pliku",
  "import.unknown_field": "Nieznane pole",
  "import.missing_value": "Brak wymaganej wartości",
  "import.invalid_value": "Nieprawidłowa wartość",
  "import.unmapped_type": "Typ transakcji bez mapowania",
  "import.ignored_row": "Wiersz pominięty",
  "import.fx_missing": "Brak kursu waluty (fx_rate)",
  "import.amount": "Brak lub niespójne kwoty",
  "import.amount_mismatch": "Kwota nie zgadza się z wartością, prowizją i podatkiem",
  "import.cash_sign": "Znak kwoty nie pasuje do typu transakcji",
  "import.missing_instrument": "Brak instrumentu",
  "import.missing_quantity": "Brak liczby sztuk",
  "import.unknown_split_ratio": "Split bez współczynnika",
  "import.negative_amount": "Ujemna liczba sztuk lub kwota",
  "import.inconsistent_file": "Niespójne dane w pliku",
  "import.position_snapshot": "Niespójny stan pozycji w pliku",
  "import.instrument_note": "Uwaga do instrumentu",
  "import.unknown_instrument": "Nieznany instrument",
  "import.history_gap_hint": "Możliwa luka w historii",
  "import.importer_error": "Importer nie rozpoznał pliku",

  // ---- agent proposals: summary by kind ---------------------------------------------------------
  "proposal.strategy": (p) => has(p, "rules", "buckets")
    ? `Nowa strategia: ${plural(Number(p.rules), "reguła", "reguły", "reguł")}, ${plural(Number(p.buckets), "koszyk", "koszyki", "koszyków")}`
      + (Number(p.inactive_rules) ? `, ${plural(Number(p.inactive_rules), "nieaktywna reguła", "nieaktywne reguły", "nieaktywnych reguł")}` : "")
    : null,
  // never the raw rule id or kind (F7 D2); a custom_rule proposal always adds a rule (an existing id = rule_exists),
  // and its params carry no condition text. No params (older proposal) = still Polish, not the English summary.
  "proposal.custom_rule": (p) => (p.rule_kind === "custom" ? "Nowa reguła własna" : "Nowa reguła")
    + (p.episodes != null ? `: w teście wstecznym ${plural(Number(p.episodes), "epizod", "epizody", "epizodów")}` : ""),
  "proposal.import": (p) => has(p, "account")
    ? `Import do ${p.account}` + (p.converter ? ` (konwerter ${p.converter})` : p.importer ? ` (${p.importer})` : "")
      + (p.new != null ? `: ${plural(Number(p.new), "nowy wiersz", "nowe wiersze", "nowych wierszy")}` : ": konwerter czeka na zatwierdzenie")
    : null,
  // ---- agent proposals: why applying failed (result.error_code) -----------------------------------
  "proposal.error.invalid": "Propozycja jest nieprawidłowa",
  "proposal.error.unknown_kind": "Nieznany rodzaj propozycji",
  "proposal.error.too_long": "Uzasadnienie jest za długie",
  "proposal.error.invalid_status": "Nieznany status propozycji",
  "proposal.error.not_pending": "Propozycja nie czeka już na decyzję",
  "proposal.error.invalid_strategy": "Strategia po tej zmianie nie przechodzi walidacji",
  "proposal.error.rule_invalid": "Proponowana reguła nie przechodzi walidacji",
  "proposal.error.rules_made_inactive": "Ta zmiana wyłączyłaby inne reguły",
  "proposal.error.strategy_unreadable": "Nie można odczytać obecnych plików strategii",
  "proposal.error.base_changed": "Pliki strategii zmieniły się od czasu propozycji; poproś agenta o nową",
  "proposal.error.strategy_missing": "Brak pliku strategii albo nie można go odczytać",
  "proposal.error.rule_exists": "Strategia ma już regułę o tym id",
  "proposal.error.staged_missing": "Zapisany plik eksportu zniknął; zaproponuj import jeszcze raz",
  "proposal.error.staged_changed": "Zapisany plik eksportu się zmienił; zaproponuj import jeszcze raz",
  "proposal.error.converter_missing": "Brak skryptu konwertera",
  "proposal.error.converter_changed": "Skrypt konwertera zmienił się od czasu propozycji; poproś agenta o nową",
  "proposal.error.converter_failed": "Konwerter nie zadziałał",
  "proposal.error.import_failed": "Import się nie udał",
  "proposal.error.import_blocked": "Tego pliku nie da się teraz zaimportować",
  "proposal.error.interrupted": "Zatwierdzanie przerwane (aplikacja się zamknęła): sprawdź wynik przed nową propozycją",
  "proposal.error.converter_unsupported": "Aplikacja nie uruchamia skryptów konwertera: poproś agenta o przekonwertowany plik",
  "proposal.error.apply_failed": "Zatwierdzenie nie powiodło się (szczegóły w logu aplikacji)",
  "proposal.error.write_failed": "Nie udało się zapisać plików; nic nie zostało zmienione",

  // ---- request errors: the `X-Finanse-Error-Code` header (errorText; the English detail stays as detail) ---
  "error.not_found": "Nie znaleziono: mogło zostać usunięte w innym oknie",
  "error.alert_invalid": "Alert ma nieprawidłowe parametry",
  "error.watchlist_conflict": "Ten instrument już jest na liście obserwowanych",
  "error.watchlist_invalid": "Nie rozpoznano instrumentu: sprawdź symbol lub ISIN",
  "error.undo_expired": "Za późno na cofnięcie: minęło 15 minut",
  "error.busy": "Trwa inna operacja; spróbuj za chwilę",
  "error.planned_invalid": "Nieprawidłowy plan wpłaty: sprawdź kwotę, datę i rachunek",
  "error.planned_booked": "Ta wpłata jest już zaksięgowana z importu; planu nie można zmienić",
  "error.research_conflict": "Notatka już obsłużona (obserwowana albo odrzucona)",
  "error.research_invalid": "Nieprawidłowe dane notatki researchu",
  "error.name_taken": "Pozycja o tej nazwie już istnieje",

  // ---- alert signal facts (`message_code` + `message_params` on alert signals; the subject is added by the UI) --
  "alert.price_below": (p) => has(p, "close", "level") ? `cena ${cur(p.close, p.currency)} poniżej ${cur(p.level, p.currency)}` : null,
  "alert.price_above": (p) => has(p, "close", "level") ? `cena ${cur(p.close, p.currency)} powyżej ${cur(p.level, p.currency)}` : null,
  "alert.change_pct": (p) => has(p, "change", "window_days")
    ? `${p.direction === "down" ? "-" : p.direction === "up" ? "+" : ""}${frac(p.change)} w ${p.window_days} sesji${has(p, "threshold") ? ` (próg ${frac(p.threshold)})` : ""}`
    : null,
  "alert.drawdown_from_high": (p) => has(p, "drawdown") ? `-${frac(p.drawdown)} od szczytu${has(p, "high") ? ` ${cur(p.high, p.currency)}` : ""}${has(p, "threshold") ? ` (próg -${frac(p.threshold)})` : ""}` : null,
  "alert.new_high": (p) => has(p, "close") ? `nowy szczyt ${cur(p.close, p.currency)}${has(p, "window_days") ? ` (${p.window_days} sesji)` : ""}` : null,
  "alert.sma_cross": (p) => has(p, "close", "window_days") ? `cena ${cur(p.close, p.currency)} ${p.direction === "above" ? "powyżej" : "poniżej"} SMA ${p.window_days}${has(p, "sma") ? ` (${cur(p.sma, p.currency)})` : ""}` : null,
  "alert.range_breakout": (p) => has(p, "window_days") && (has(p, "range_high") || has(p, "range_low"))
    ? `wybicie z konsolidacji ${p.window_days} sesji${has(p, "breakout_pct") ? (Math.abs(Number(p.breakout_pct)) < 0.0005 ? " tuż" : ` ${Number(p.breakout_pct) < 0 ? "-" : "+"}${frac(p.breakout_pct)}`) : ""} ${Number(p.breakout_pct) < 0 ? `pod ${cur(p.range_low, p.currency)}` : `nad ${cur(p.range_high, p.currency)}`}`
    : null,
  "alert.volume_spike": (p) => has(p, "ratio", "window_days")
    ? `wolumen ${Number(p.ratio).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x średniej z ${p.window_days} sesji`
    : null,
  "alert.weight_above": (p) => has(p, "weight", "threshold") ? `udział ${frac(p.weight)} powyżej ${frac(p.threshold)}` : null,
  "alert.weight_below": (p) => has(p, "weight", "threshold") ? `udział ${frac(p.weight)} poniżej ${frac(p.threshold)}` : null,
  "alert.custom": "warunek spełniony",

  // ---- watchlist warnings (`warning_codes` of POST watchlist) -----------------------------------------
  "watchlist.guessed_price_symbol": (p) => `symbol ceny zgadnięty${p.price_symbol ? ` (${p.price_symbol})` : ""}: sprawdź, czy przyjdą notowania`,
  "watchlist.no_price_symbol": "brak symbolu ceny: dodaj alias Yahoo w klasyfikacji",

  // ---- performance data quality (`data_quality.notes[] {code, params}` of GET investments/performance) -------
  "perf.incomplete_days": (p) => has(p, "days") ? `niepełna wycena: ${plural(Number(p.days), "dzień", "dni", "dni")}` : "niepełna wycena części dni",
  "perf.implied_funding": "ujemna gotówka liczona jako wpłata: sprawdź, czy w historii nie brakuje wpłaty",
  "perf.price_scale_inferred": (p) => has(p, "instruments")
    ? `ceny przeskalowane (niezaksięgowany split?): ${plural(Number(p.instruments), "instrument", "instrumenty", "instrumentów")}`
    : "ceny przeskalowane (niezaksięgowany split?)",
  "perf.unknown_flows": (p) => has(p, "flows") ? `przepływy bez wyceny liczone jako 0: ${p.flows}` : "przepływy bez wyceny liczone jako 0",
  "perf.benchmark_partial": (p) => has(p, "first_date") ? `benchmark: ceny dopiero od ${dmyText(p.first_date)}` : "benchmark: ceny tylko od części zakresu",
  "perf.benchmark_stale": (p) => has(p, "last_date") ? `benchmark: ceny tylko do ${dmyText(p.last_date)}, bez porównania` : "benchmark: nieaktualne ceny, bez porównania",

  // ---- worker jobs (`code` + `params` of GET /api/system worker.jobs[]; `detail` is the English fallback) ----
  "worker.eb_not_configured": "Enable Banking nie jest skonfigurowany",
  "worker.no_bank_sessions": "brak sesji bankowych",
  "worker.throttled": (p) => (has(p, "until") ? `limit banku do ${whenText(p.until)}` : "limit banku"),
  "worker.disabled_for_run": "wyłączone w tym przebiegu",
  "worker.busy": "inny przebieg w toku",
  "worker.notifier_none": "bez powiadomień",
  "worker.digest_already_sent": "już wysłane dziś",
  // params {rule} = the raw rule id (or index): never shown; the payload carries no kind for a Polish label
  "worker.rule_inactive": "reguła nieaktywna (błąd w strategy.yaml)",
  "worker.strategy_invalid": "strategia z błędem, reguły nie ruszyły",
  "worker.market_failed": "notowania niedostępne",
  "worker.prices_failed": "brak notowań {instrument}",
  "worker.fx_failed": "brak kursu {currency}",

  // ---- moved app (GET /api/system worker.relocation, F7 PK11) ----------------------------------------------
  "relocation.missing": "Praca w tle wskazuje program, którego już nie ma",
  "relocation.other_program": "Praca w tle wskazuje inną kopię aplikacji",
  "relocation.moved": "Aplikacja została przeniesiona z {path}",
  "relocation.mcp_readd": "Dodaj ponownie serwer MCP w Claude Code (polecenie w Agent AI).",
};

/** Fill "{name}" placeholders; null when a placeholder has no value (the caller falls back). */
export function fill(template: string, params: Params): string | null {
  let missing = false;
  const out = template.replace(/\{([a-z_]+)\}/g, (_m, key: string) => {
    const v = params[key];
    if (v === undefined || v === null || v === "") { missing = true; return ""; }
    return String(v);
  });
  return missing ? null : out;
}

/** The Polish label of `code` with `params`, or null (unknown code / missing params). */
export function label(code: string | null | undefined, params?: Params | null): string | null {
  if (!code) return null;
  const l = LABELS[code];
  if (l === undefined) return null;
  const p = params ?? {};
  return typeof l === "string" ? fill(l, p) : l(p);
}

/** What the UI shows for one backend message: the Polish `text` (or the English original when there
 * is no label), and the English `detail` when it carries more than the label (import warnings,
 * proposal errors), else null. */
export interface Described { text: string; detail: string | null; translated: boolean }

/** A strategy issue (`{code, params, message}`); servers without codes get the English message. */
export function describeIssue(i: { code?: string | null; params?: Params | null; message: string }): Described {
  const pl = label(i.code, i.params);
  return pl ? { text: pl, detail: null, translated: true } : { text: i.message, detail: null, translated: false };
}

/** An import warning (`{kind, message, code?}`): Polish kind label, the English message as detail. */
export function describeImportWarning(w: { kind?: string | null; code?: string | null; message: string }): Described {
  const code = w.code ?? (w.kind ? `import.${w.kind}` : null);
  const pl = label(code);
  return pl ? { text: pl, detail: w.message, translated: true } : { text: w.message, detail: null, translated: false };
}

/** A proposal's one-line summary (`summary_code` = kind, `summary_params`), else the English summary. */
export function proposalSummary(p: { kind?: string; summary?: string | null; summary_code?: string | null; summary_params?: Params | null }): string | null {
  const code = p.summary_code ?? p.kind;
  return label(code ? `proposal.${code}` : null, p.summary_params) ?? p.summary ?? null;
}

/** Why a proposal could not be applied (`result {error, error_code}`), or null when it did not fail. */
export function proposalError(result: Record<string, unknown> | null | undefined): Described | null {
  if (!result) return null;
  const english = typeof result.error === "string" ? result.error : null;
  const code = typeof result.error_code === "string" ? result.error_code : null;
  if (!english && !code) return null;
  const pl = label(code ? `proposal.error.${code}` : null);
  if (pl) return { text: pl, detail: english, translated: true };
  return { text: english ?? code ?? "", detail: null, translated: false };
}

/** What a failed request shows: the Polish label of its `X-Finanse-Error-Code` (`error.<code>`, a
 * proposal code as `proposal.error.<code>`) with the server's English detail kept as `detail`; without a
 * known code the English detail itself. A network failure (no response) gets one Polish line. */
export function describeError(e: unknown): Described {
  const err = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; message?: unknown; status?: unknown; name?: unknown };
  const english = typeof err.message === "string" ? err.message : String(e ?? "");
  const code = typeof err.code === "string" && err.code ? err.code : null;
  const pl = code ? label(`error.${code}`) ?? label(`proposal.error.${code}`) : null;
  if (pl) return { text: pl, detail: english && english !== pl ? english : null, translated: true };
  if (err.status === undefined && err.name === "TypeError" && /fetch|network|load failed/i.test(english)) {
    return { text: "Brak połączenia z aplikacją (serwer finanse nie odpowiada)", detail: english, translated: true };
  }
  return { text: english, detail: null, translated: false };
}

/** One line for a toast: the Polish label of the error code, else the English detail. */
export const errorText = (e: unknown): string => describeError(e).text;

/** A performance data-quality note (`{code, params, message}`): the Polish label, else the English message. */
export function describePerfNote(n: { code?: string | null; params?: Params | null; message?: string | null }): string {
  return label(n.code ? `perf.${n.code}` : null, n.params) ?? n.message ?? n.code ?? "";
}

/** A worker job's outcome (`code` + `params`, F7): the Polish label, else the English `detail`. */
export function describeJob(j: { code?: string | null; params?: Params | null; detail?: string | null }): string | null {
  return label(j.code ? `worker.${j.code}` : null, j.params) ?? j.detail ?? null;
}

/** The two parts of a moved app / stale config (F7 PK11, R8), each one line or null when fine: `worker` (the
 * launchd job, fixed by reinstalling) and `mcp` (the MCP lines, the owner re-adds them and marks it done). An
 * older server's flat object (`worker` reason + `app_moved_from`) maps onto the same parts. */
export function relocationParts(r: unknown): { worker: string | null; mcp: string | null } {
  if (!r || typeof r !== "object") return { worker: null, mcp: null };
  const o = r as { worker?: unknown; mcp?: unknown; app_moved_from?: unknown };
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const part = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  const legacy = !("mcp" in o);
  const workerReason = legacy ? str(o.worker) : str(part(o.worker)?.reason);
  const mcpPart = legacy ? (str(o.app_moved_from) ? { app_moved_from: o.app_moved_from } : null) : part(o.mcp);
  const movedFrom = str(mcpPart?.app_moved_from);
  return {
    worker: workerReason ? label(`relocation.${workerReason}`) ?? workerReason : null,
    mcp: mcpPart ? [movedFrom ? label("relocation.moved", { path: movedFrom }) : null, label("relocation.mcp_readd")].filter(Boolean).join(". ") : null,
  };
}
