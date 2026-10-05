// Dev-only demo backend for the F1 shell (`VITE_MOCK=1 npm run dev`). Implements the
// wave 2 API contract in memory with invented data, so the shell can be built and
// screenshotted before (or without) the real backend. Never bundled unless the flag
// is set; state resets on reload.
//
// Scenarios via the query string: ?mock=first (no profile, legacy DB found),
// ?mock=one (one full profile), ?mock=two (default: full profile + a new one).
import { investmentsMock, mcpCallsMock } from "../modules/investments/mock";
import {
  ApiError, type ModuleInfo, type Profile, type ProfileModule, type SetupInfo, type SetupState, type SetupStep,
} from "./api";

const TODAY = "2026-10-04";

const MODULES: ModuleInfo[] = [
  { id: "budget", name: "Budżet domowy", description: "Konta bankowe, wydatki, przepływy i subskrypcje.", depends_on: [], available: true },
  { id: "assets", name: "Majątek", description: "Ręcznie wyceniane aktywa.", depends_on: [], available: true },
  { id: "loans", name: "Kredyty", description: "Harmonogramy kredytów.", depends_on: [], available: true },
  { id: "investments", name: "Inwestycje", description: "Rachunki maklerskie i strategia.", depends_on: [], available: true },
];

type Kind = "full" | "empty";
interface MockProfile extends Profile { kind: Kind }

const mods = (s: Record<string, SetupState | null>): ProfileModule[] =>
  Object.entries(s).map(([id, st]) => ({ id, enabled: st !== null, setup_state: st ?? "empty" }));

const JAN: MockProfile = {
  slug: "jan", name: "Jan", base_currency: "PLN", mcp_privacy: "strict", kind: "full",
  modules: mods({ budget: "ready", loans: "ready", assets: "ready", investments: "partial" }),
};
const MARTA: MockProfile = {
  slug: "marta", name: "Marta", base_currency: "PLN", mcp_privacy: "strict", kind: "empty",
  modules: mods({ budget: "empty", investments: "partial" }),
};

const scenario = new URLSearchParams(location.search).get("mock") ?? "two";
const db = {
  profiles: (scenario === "first" ? [] : scenario === "one" ? [JAN] : [JAN, MARTA]).map((p) => structuredClone(p)),
  legacy: scenario === "first",
};

// ---- deterministic pseudo-random -------------------------------------------
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---- full demo dataset (invented) ------------------------------------------
const ACCOUNTS = [
  { id: 1, bank: "mbank", name: "eKonto osobiste", type: "checking", currency: "PLN", iban_tail: "4821", balance: 8412.37, as_of: TODAY, is_liability: false },
  { id: 2, bank: "mbank", name: "Konto oszczędnościowe", type: "savings", currency: "PLN", iban_tail: "1190", balance: 41250, as_of: TODAY, is_liability: false },
  { id: 3, bank: "erste", name: "Konto Erste", type: "checking", currency: "PLN", iban_tail: "7702", balance: 2318.9, as_of: "2026-10-03", is_liability: false },
  { id: 4, bank: "mbank", name: "Karta kredytowa", type: "credit", currency: "PLN", iban_tail: "0044", balance: -1184.22, as_of: TODAY, is_liability: true },
  { id: 5, bank: "manual", name: "Gotówka", type: "cash", currency: "PLN", iban_tail: "", balance: 640, as_of: TODAY, is_liability: false },
  { id: 6, bank: "manual", name: "Mieszkanie", type: "property", currency: "PLN", iban_tail: "", balance: 545000, as_of: "2026-09-01", is_liability: false },
  { id: 7, bank: "manual", name: "Toyota Corolla", type: "vehicle", currency: "PLN", iban_tail: "", balance: 52600, as_of: "2026-09-01", is_liability: false },
  { id: 8, bank: "manual", name: "Hipoteka", type: "mortgage", currency: "PLN", iban_tail: "", balance: -338912.45, as_of: TODAY, is_liability: true },
  { id: 9, bank: "pekao", name: "Kredyt samochodowy", type: "loan", currency: "PLN", iban_tail: "3317", balance: -24105.6, as_of: TODAY, is_liability: true },
  { id: 10, bank: "erste", name: "Konto walutowe EUR", type: "savings", currency: "EUR", iban_tail: "5520", balance: 1250, as_of: "2026-10-03", is_liability: false },
];

function breakdown(accounts: typeof ACCOUNTS) {
  const pln = accounts.filter((a) => a.currency === "PLN");
  const by: Record<string, number> = {};
  let assets = 0, liabilities = 0, property = 0, mortgage = 0;
  for (const a of pln) {
    by[a.type] = r2((by[a.type] ?? 0) + a.balance);
    if (a.balance >= 0) assets += a.balance; else liabilities -= a.balance;
    if (a.type === "property") property += a.balance;
    if (a.type === "mortgage") mortgage -= a.balance;
  }
  return {
    currency: "PLN", assets: r2(assets), liabilities: r2(liabilities), net: r2(assets - liabilities),
    property: r2(property), mortgage: r2(mortgage), home_equity: r2(property - mortgage), by_type: by,
  };
}

function totals(accounts: typeof ACCOUNTS) {
  const t: Record<string, number> = {};
  for (const a of accounts) t[a.currency] = r2((t[a.currency] ?? 0) + a.balance);
  return t;
}

const MARTA_ACCOUNTS = [
  { id: 101, bank: "manual", name: "Gotówka", type: "cash", currency: "PLN", iban_tail: "", balance: 350, as_of: TODAY, is_liability: false },
];
const accountsOf = (p: MockProfile) => (p.kind === "full" ? ACCOUNTS : p.slug === "marta" ? MARTA_ACCOUNTS : []);

function months(from: string, n: number): string[] {
  const [y0, m0] = from.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const t = y0 * 12 + (m0 - 1) + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  });
}

const SERIES_MONTHS = months("2024-04", 31);
seed = 7;
const SERIES = SERIES_MONTHS.map((ym, i) => {
  const k = i / (SERIES_MONTHS.length - 1);
  const money = r2(19000 + 33000 * k + (rnd() - 0.5) * 4000);
  const property = r2(510000 + 35000 * k);
  const vehicle = r2(68000 - 15400 * k);
  const mortgage = r2(-372000 + 33100 * k);
  const loan = r2(-38000 + 13900 * k);
  return { date: `${ym}-01`, components: { money, property, vehicle, mortgage, loan } };
});

const CASHFLOW_MONTHS = months("2024-05", 30);
seed = 11;
const CASHFLOW = CASHFLOW_MONTHS.map((label, i) => {
  const income = r2(14200 + rnd() * 1600 + (i % 12 === 11 ? 6000 : 0));
  const expense = r2(9200 + rnd() * 3800);
  return { label, income, expense, net: r2(income - expense) };
});

const CATEGORIES = [
  ["groceries", "Zakupy spożywcze", "expense"], ["restaurants", "Restauracje", "expense"], ["transport", "Transport", "expense"],
  ["fuel", "Paliwo", "expense"], ["housing", "Mieszkanie i rachunki", "expense"], ["subscriptions", "Subskrypcje", "expense"],
  ["health", "Zdrowie", "expense"], ["shopping", "Zakupy", "expense"], ["entertainment", "Rozrywka", "expense"],
  ["travel", "Podróże", "expense"], ["kids", "Dzieci", "expense"], ["loans", "Spłata kredytu", "expense"],
  ["other", "Inne", "expense"], ["salary", "Wynagrodzenie", "income"], ["transfer", "Przelew wewnętrzny", "transfer"],
].map(([key, label, kind]) => ({ key, label, kind }));

const SPEND_BASE: [string, number][] = [
  ["housing", 2380.4], ["groceries", 1964.18], ["loans", 3302.15], ["restaurants", 612.5], ["fuel", 498.3],
  ["shopping", 742.99], ["subscriptions", 487.97], ["kids", 455], ["health", 210], ["entertainment", 164.4],
  ["transport", 96], ["travel", 38.5], ["other", 24.9],
];

function spending(q: URLSearchParams) {
  const mult = q.get("month") ? 1 : q.get("quarter") ? 3 : q.get("year") ? 12 : 26;
  const label = new Map(CATEGORIES.map((c) => [c.key, c.label]));
  return SPEND_BASE.map(([k, v]) => ({ category: k, label: label.get(k) ?? k, amount: r2(v * mult) })).sort((a, b) => b.amount - a.amount);
}

const MERCHANTS: Record<string, string[]> = {
  groceries: ["Biedronka", "Lidl", "Żabka"], restaurants: ["Pizzeria Roma", "Bar Mleczny"], fuel: ["Orlen", "BP"],
  housing: ["Spółdzielnia Mieszkaniowa", "Tauron", "PGNiG"], shopping: ["Allegro", "Decathlon"],
};

function drill(key: string) {
  const names = MERCHANTS[key] ?? ["Sklep internetowy", "Usługa lokalna"];
  seed = key.length * 31;
  return Array.from({ length: 6 }, (_, i) => {
    const m = names[i % names.length];
    return {
      id: 9000 + i, date: `2026-09-${String(28 - i * 4).padStart(2, "0")}`, amount: -r2(20 + rnd() * 280), currency: "PLN",
      merchant: m, merchant_key: m.toLowerCase(), details: null, counterparty: null, category: key, category_source: "rule",
      account: i % 2 ? "Konto Erste" : "eKonto osobiste",
    };
  });
}

const RECURRING = [
  ["Netflix", 49, 30, "2026-09-22"], ["Spotify", 23.99, 30, "2026-09-18"], ["Siłownia FitZone", 139, 30, "2026-10-01"],
  ["Orange światłowód", 79.99, 30, "2026-09-25"], ["PGNiG gaz", 120, 61, "2026-09-10"], ["Apple iCloud", 11.99, 30, "2026-09-29"],
  ["Ubezpieczenie OC", 64, 30, "2026-09-15"],
].map(([payee, amount, gap, last]) => ({ payee, amount, currency: "PLN", count: 12, gap_days: gap, last, active: true }));

function annuity(name: string, id: number, principal: number, rate: number, term: number, start: string) {
  const r = rate / 12;
  const pay = r2((principal * r) / (1 - Math.pow(1 + r, -term)));
  let bal = principal, paidInterest = 0, totalInterest = 0, elapsed = 0, outstanding = principal;
  const schedule = [];
  const ms = months(start.slice(0, 7), term);
  for (let n = 1; n <= term; n++) {
    const interest = r2(bal * r);
    const princ = r2(Math.min(bal, pay - interest));
    bal = r2(bal - princ);
    totalInterest += interest;
    const date = `${ms[n - 1]}-${start.slice(8, 10)}`;
    if (date <= TODAY) { paidInterest += interest; elapsed = n; outstanding = bal; }
    schedule.push({ n, date, payment: r2(princ + interest), interest, principal: princ, balance: bal });
  }
  return {
    id, name, has_loan: true, currency: "PLN", principal, annual_rate: rate, monthly_payment: pay,
    outstanding: r2(outstanding), total_interest: r2(totalInterest), paid_interest: r2(paidInterest),
    payoff_date: schedule[schedule.length - 1].date, months_elapsed: elapsed,
    series: schedule.map((s) => ({ date: s.date, balance: s.balance })), schedule,
  };
}
const LOANS = [
  annuity("Hipoteka", 1, 420000, 0.0685, 300, "2021-03-10"),
  annuity("Kredyt samochodowy", 2, 60000, 0.089, 72, "2023-02-15"),
];

// ---- setup status per module ------------------------------------------------
type StepDef = [title: string, description: string, actions?: SetupStep["actions"]];
const SETUP: Record<string, StepDef[]> = {
  budget: [
    ["Dodaj bank i konto", "Bank, rodzaj konta i waluta. Konto = jeden rachunek w jednym banku.", [{ kind: "cli", label: "Kopiuj polecenie", target: "finanse import statements/" }]],
    ["Wgraj pierwszy CSV lub połącz Open Banking", "Eksport CSV z banku (mBank, Pekao, Erste) albo połączenie przez Enable Banking."],
    ["Sprawdź kategorie (10 najczęstszych sprzedawców)", "Popraw kategorię w zakładce Wydatki; reguła zapamięta sprzedawcę.", [{ kind: "tab", label: "Wydatki", target: "expenses" }]],
    ["Oznacz przelewy wewnętrzne", "Przelewy między własnymi kontami są dopasowywane po IBAN, żeby nie liczyły się jako wydatki."],
  ],
  loans: [
    ["Dodaj kredyt (kwota, oprocentowanie, rata, start)", "Hipoteka, kredyt samochodowy lub gotówkowy. Wiele kredytów na profil."],
    ["Wskaż konto, z którego schodzi rata", "Raty są wtedy rozpoznawane w Budżecie jako spłata kredytu."],
  ],
  assets: [
    ["Dodaj pozycję", "Mieszkanie, auto lub inne aktywo z wyceną i datą."],
    ["Ustaw krzywą utraty wartości (auto)", "Auto traci na wartości co miesiąc według krzywej; wycenę można nadpisać ręcznie."],
  ],
};

const INVEST_NEW: StepDef[] = [
  ["Dodaj rachunek maklerski", "XTB · IKE · PLN · dodano 2026-10-04. Rachunek = jeden broker + jedno opakowanie (zwykłe, IKE, IKZE).", [{ kind: "drawer", label: "Dodaj kolejny", target: "add-account" }]],
  ["Zapisz strategię", "Bez historii transakcji zacznij od strategii: cel, horyzont, koszyki i reguły trafiają do strategy.yaml, a opis słowny do strategy.md. Najprościej przez wywiad w Claude Code (niżej); można też zacząć od szablonu.", [{ kind: "drawer", label: "Utwórz z szablonu", target: "strategy-template" }]],
  ["Pierwsza wpłata lub import", "Dodaj transakcję ręcznie albo zaimportuj CSV z XTB, gdy pojawią się pierwsze zakupy. Bez tego portfel ma wartość 0 zł, a reguły są pomijane.", [{ kind: "drawer", label: "Dodaj transakcję", target: "add-txn" }, { kind: "drawer", label: "Import CSV", target: "import" }]],
  ["Sklasyfikuj instrumenty", "Klasa aktywów i koszyk dla każdego instrumentu. Pojawi się po pierwszym imporcie; agent może zaproponować klasyfikację."],
];
const INVEST_HISTORY: StepDef[] = [
  ["Dodaj rachunek maklerski", "XTB · zwykły · PLN · dodano 2026-09-28. Rachunek = jeden broker + jedno opakowanie (zwykłe, IKE, IKZE).", [{ kind: "drawer", label: "Dodaj kolejny", target: "add-account" }]],
  ["Zaimportuj historię transakcji", "Eksport z brokera bywa dziurawy: w kroku importu uzgodnisz stan ze snapshotem brokera.", [{ kind: "drawer", label: "Import CSV", target: "import" }]],
  ["Sklasyfikuj instrumenty", "Klasa aktywów i koszyk dla każdego instrumentu; agent może zaproponować klasyfikację."],
  ["Zapisz strategię", "Z historią skill zaczyna od retrospekcji: co działało, co nie, zanim zaproponuje reguły."],
];

function setupOf(p: MockProfile, id: string): SetupInfo {
  const pm = p.modules.find((m) => m.id === id);
  const state = pm?.setup_state ?? "empty";
  const defs = id === "investments" ? (p.kind === "full" ? INVEST_HISTORY : INVEST_NEW) : SETUP[id] ?? [];
  const done = state === "ready" ? defs.length : state === "partial" ? 1 : 0;
  return {
    state,
    steps: defs.map(([title, description, actions], i) => ({
      id: `s${i + 1}`, title, description, actions: actions ?? [],
      status: i < done ? "done" : i === done ? "on" : "todo",
    })),
    skill: { command: `/${id}-setup`, mcp_add: `claude mcp add finanse-${p.slug} -- finanse mcp --profile ${p.slug}` },
  };
}

// ---- router -----------------------------------------------------------------
const publicProfile = ({ kind: _k, ...p }: MockProfile): Profile => structuredClone(p);

function slugify(name: string): string {
  const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profil";
  let s = base, i = 2;
  while (db.profiles.some((p) => p.slug === s)) s = `${base}-${i++}`;
  return s;
}

function findProfile(slug: string): MockProfile {
  const p = db.profiles.find((x) => x.slug === slug);
  if (!p) throw new ApiError(404, `Nie ma profilu ${slug}`);
  return p;
}

function profileApi(p: MockProfile, path: string, q: URLSearchParams, method: string, body?: unknown): unknown {
  const accounts = accountsOf(p);
  const full = p.kind === "full";
  const bd = breakdown(accounts);
  const setup = path.match(/^\/modules\/([^/]+)\/setup$/);
  if (setup) return setupOf(p, setup[1]);
  switch (path) {
    case "/summary":
      return {
        networth: totals(accounts), breakdown: bd,
        month: full ? { label: "2026-09", income: 15240, expense: 10982.73, net: 4257.27 } : null,
        subscriptions: full ? { count: 7, monthly_total: 487.97, monthly_totals: { PLN: 487.97 } } : { count: 0, monthly_total: 0, monthly_totals: {} },
      };
    case "/networth":
      return { totals: totals(accounts), breakdown: bd, accounts };
    case "/networth/series": {
      if (!full) return { points: [], components: [] };
      const liquid = q.get("scope") === "liquid";
      const comps = [
        { key: "money", label: "Pieniądze", liability: false }, { key: "property", label: "Nieruchomości", liability: false },
        { key: "vehicle", label: "Auto", liability: false }, { key: "mortgage", label: "Hipoteka", liability: true },
        { key: "loan", label: "Pożyczki", liability: true },
      ].filter((c) => !liquid || c.key === "money");
      return {
        components: comps,
        points: SERIES.map((pt) => {
          const c = Object.fromEntries(comps.map((x) => [x.key, pt.components[x.key as keyof typeof pt.components]]));
          return { date: pt.date, value: r2(Object.values(c).reduce((s, v) => s + v, 0)), components: c };
        }),
      };
    }
    case "/cashflow": return full ? CASHFLOW : [];
    case "/recurring": return { items: full ? RECURRING : [] };
    case "/categories": return CATEGORIES;
    case "/spending": return full ? spending(q) : [];
    case "/cash":
      return full
        ? {
            exists: true, account_id: 5, currency: "PLN", balance: 640, withdrawals: 1200, expenses: 560,
            transactions: [
              { id: 501, date: "2026-09-30", amount: -86, title: "Targ warzywny", category: "groceries", category_label: "Zakupy spożywcze", kind: "expense" },
              { id: 502, date: "2026-09-21", amount: -74, title: "Fryzjer", category: "other", category_label: "Inne", kind: "expense" },
              { id: 503, date: "2026-09-12", amount: 400, title: "Wypłata z bankomatu", category: "cash_withdrawal", category_label: "Wypłata gotówki", kind: "withdrawal" },
            ],
          }
        : { exists: p.slug === "marta", currency: "PLN", balance: p.slug === "marta" ? 350 : 0, withdrawals: 0, expenses: 0, transactions: [] };
    case "/loans": return full ? LOANS : [];
    case "/resync":
      if (method !== "POST") break;
      return { ok: true, inserted: 12, pairs: 1, banks: [{ bank: "mbank", inserted: 9, accounts: 3 }, { bank: "erste", inserted: 3, accounts: 2 }], errors: [] };
  }
  const drillM = path.match(/^\/category\/([^/]+)\/transactions$/);
  if (drillM) return full ? drill(decodeURIComponent(drillM[1])) : [];
  if (/^\/transactions\/\d+\/category$/.test(path)) return { ok: true };
  if (path === "/merchant-category") return { updated: 5 };
  if (path === "/cash/expense") return { ok: true, id: 599 };
  if (path.startsWith("/cash/transaction/")) return { ok: true };
  // F3: investments workspace + track M contract (reviews, proposals, MCP audit log).
  if (path.startsWith("/investments") || path.startsWith("/reviews") || path.startsWith("/proposals")) {
    return investmentsMock(p.slug, p.kind, path, q, method, body);
  }
  if (path === "/mcp/calls") return mcpCallsMock(p.kind);
  throw new ApiError(404, `mock: brak ${method} ${path}`);
}

// F3: background worker (track W contract), kept in memory.
const worker = {
  installed: false, label: "io.finanse.worker", schedule: "07:30", last_run: null as string | null,
  last_status: null as string | null, next_run: null as string | null, log_path: "~/Library/Application Support/finanse/logs/worker.log",
  platform: "launchd", supported: true, job_path: "~/Library/LaunchAgents/io.finanse.worker.plist", program: null as string[] | null,
  jobs: [] as { job: string; module: string | null; status: string; detail: string | null; last_run: string | null }[],
};

function route(method: string, url: string, body: unknown): unknown {
  const u = new URL(url, location.origin);
  const path = u.pathname;
  if (path === "/api/system") {
    return {
      version: "0.2.0-dev (demo)", data_dir: "~/Library/Application Support/finanse",
      legacy_db_detected: db.legacy, legacy_db_path: db.legacy ? "data/finanse.db" : null,
      worker: { ...worker },
    };
  }
  const wk = path.match(/^\/api\/system\/worker\/(install|uninstall|run)$/);
  if (wk && method === "POST") {
    const b = (body ?? {}) as { time?: string };
    if (wk[1] === "install") Object.assign(worker, { installed: true, schedule: b.time || worker.schedule, next_run: `2026-10-05T${b.time || worker.schedule}:00+02:00`, program: ["finanse", "worker", "run"] });
    if (wk[1] === "uninstall") Object.assign(worker, { installed: false, next_run: null, program: null });
    if (wk[1] === "run") {
      const at = new Date().toISOString();
      worker.jobs = [
        { job: "investments.daily", module: "investments", status: "partial", detail: "jan: stooq: 1 źródło cen nie odpowiedziało", last_run: at },
        { job: "budget.sync", module: "budget", status: "skipped", detail: "jan: limit banku do 13:10", last_run: at },
        { job: "notifications", module: null, status: "ok", detail: null, last_run: at },
        { job: "digest", module: null, status: "skipped", detail: null, last_run: at },
      ];
      Object.assign(worker, { last_run: at, last_status: "partial" });
      return { run: { status: "partial", summary: worker.jobs }, worker: { ...worker } };
    }
    return { worker: { ...worker } };
  }
  if (path === "/api/modules") return MODULES;
  if (path === "/api/profiles" && method === "GET") return db.profiles.map(publicProfile);
  if (path === "/api/profiles" && method === "POST") {
    const b = body as { name: string; base_currency: string; modules: string[]; mcp_privacy: Profile["mcp_privacy"] };
    const name = (b.name ?? "").trim();
    if (!name) throw new ApiError(422, "Nazwa profilu jest wymagana.");
    if (db.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, "Profil o tej nazwie już istnieje.");
    const p: MockProfile = {
      slug: slugify(name), name, base_currency: b.base_currency || "PLN", mcp_privacy: b.mcp_privacy || "strict", kind: "empty",
      modules: MODULES.filter((m) => b.modules.includes(m.id)).map((m) => ({ id: m.id, enabled: true, setup_state: "empty" })),
    };
    db.profiles.push(p);
    return publicProfile(p);
  }
  const pm = path.match(/^\/api\/profiles\/([^/]+)(\/modules)?$/);
  if (pm) {
    const p = findProfile(decodeURIComponent(pm[1]));
    if (pm[2] && method === "PUT") {
      const want = (body as { modules: string[] }).modules;
      for (const id of want) if (!p.modules.some((m) => m.id === id)) p.modules.push({ id, enabled: true, setup_state: "empty" });
      for (const m of p.modules) m.enabled = want.includes(m.id);
      return publicProfile(p);
    }
    if (!pm[2] && method === "PATCH") {
      Object.assign(p, body as object);
      return publicProfile(p);
    }
  }
  const scoped = path.match(/^\/api\/p\/([^/]+)(\/.*)$/);
  if (scoped) return profileApi(findProfile(decodeURIComponent(scoped[1])), scoped[2], u.searchParams, method, body);
  throw new ApiError(404, `mock: brak ${method} ${path}`);
}

export async function mockFetch(method: string, url: string, body?: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 120));
  return structuredClone(route(method, url, body));
}
