// Polish labels for backend messages that carry a stable code: strategy issues (`code` + `params`
// from strategy/codes.py), import warnings (`import.<kind>`), agent proposal summaries
// (`summary_code` = the kind + `summary_params`) and proposal errors (`result.error_code`).
// The server text stays English; an unknown code, or a template whose params are missing, falls back
// to that English text. Pure module (no React, no DOM): tested in tests/messages.test.mjs, and the
// backend test tests/test_message_codes.py checks that every backend code has a label here.

export type Params = Record<string, unknown>;
/** A template ("{key}" placeholders) or a function; null from a function = fall back to English. */
type Label = string | ((p: Params) => string | null);

const q = (v: unknown) => `„${String(v)}"`;
const hint = (p: Params) => (p.suggestion ? ` (czy chodziło o ${q(p.suggestion)}?)` : "");
/** Values the server describes in English (`got a mapping`). */
const val = (v: unknown) =>
  ({ "a mapping": "mapą", "a list": "listą", true: "true", false: "false" } as Record<string, string>)[String(v)] ?? String(v);
const range = (r: unknown) =>
  String(r)
    .replace(/greater than/g, "większe niż")
    .replace(/at least/g, "co najmniej")
    .replace(/less than/g, "mniejsze niż")
    .replace(/at most/g, "co najwyżej")
    .replace(/ and /g, " i ");
const has = (p: Params, ...keys: string[]) => keys.every((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");

/** Polish plural: plural(5, "reguła", "reguły", "reguł") -> "5 reguł". */
export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10, n100 = n % 100;
  const w = n === 1 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${w}`;
}

const ID_WHAT: Record<string, string> = { Bucket: "koszyka", Rule: "reguły", Benchmark: "benchmarku", bucket: "koszyka", rule: "reguły" };

export const LABELS: Record<string, Label> = {
  // ---- strategy.yaml: the document --------------------------------------------------------------
  "strategy.yaml_too_large": "Plik strategy.yaml jest za duży ({chars} znaków, maks. {max})",
  "strategy.yaml_duplicate_key": "Błędny YAML: klucz „{key}\" się powtarza (pierwszy raz w linii {first_line})",
  "strategy.yaml_too_deep": "Plik strategy.yaml jest zagnieżdżony zbyt głęboko",
  "strategy.yaml_invalid": "Błędny YAML: {problem}",
  "strategy.yaml_alias": "Kotwice i aliasy YAML (& i *) nie są obsługiwane",
  "strategy.yaml_merge_key": "Klucze scalania YAML (<<) nie są obsługiwane",
  "strategy.yaml_tag": "Nieobsługiwany tag YAML {tag}",
  "strategy.yaml_key_not_text": "Klucze w YAML muszą być zwykłym tekstem",
  "strategy.empty": "Plik strategy.yaml jest pusty; potrzebuje co najmniej version i base_currency",
  "strategy.not_mapping": "strategy.yaml musi być mapą kluczy (version, base_currency, ...)",
  "strategy.md_empty": "Plik strategy.md jest pusty; zapisz w nim swoje cele, żeby raporty miały kontekst",
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
  "strategy.expression_invalid": "Błąd w warunku (kolumna {column}): {detail}",
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
  "proposal.custom_rule": (p) => has(p, "rule_id", "rule_kind")
    ? `Reguła ${p.rule_id} (${p.rule_kind})` + (p.episodes != null ? `: w teście wstecznym ${plural(Number(p.episodes), "epizod", "epizody", "epizodów")}` : "")
    : null,
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
  "proposal.error.interrupted": "Zatwierdzanie zostało przerwane (aplikacja się zamknęła); sprawdź wynik, zanim poprosisz o nową propozycję",
  "proposal.error.converter_unsupported": "Ten import wymaga skryptu konwertera, a aplikacja nie uruchamia już skryptów; poproś agenta o przekonwertowany plik",
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
