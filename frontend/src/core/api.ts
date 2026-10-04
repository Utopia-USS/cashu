// Typed client over the FastAPI backend. No business logic here - just
// transport + shapes mirroring the JSON the server returns. Profile-scoped
// endpoints live under /api/p/{slug}/...; module endpoints are in
// modules/<id>/api.ts and use the same transport.

// Per-launch API token: `finanse serve` injects it into index.html as
// <meta name="finanse-token">. Absent under `npm run dev`, where the Vite proxy
// adds the header itself (see vite.config.ts).
const TOKEN =
  document.querySelector<HTMLMetaElement>('meta[name="finanse-token"]')?.content ?? "";
const auth: Record<string, string> = TOKEN ? { "X-Finanse-Token": TOKEN } : {};

// Dev-only demo backend (`VITE_MOCK=1 npm run dev`). Off by default; the mock
// module is only loaded when the flag is set at build time.
const MOCK = import.meta.env.VITE_MOCK === "1";

/** Error with the server's `detail` message when it sent one (FastAPI style). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// A 401 means the token this page was served with is no longer valid: `finanse serve`
// was restarted (new token per launch). Nothing recovers without a reload, so the
// app shows one notice (App.tsx) instead of an error in every view.
const authLostListeners = new Set<() => void>();
let authLost = false;
export function onAuthLost(cb: () => void): () => void {
  authLostListeners.add(cb);
  if (authLost) cb();
  return () => { authLostListeners.delete(cb); };
}
function reportAuthLost() {
  if (authLost) return;
  authLost = true;
  authLostListeners.forEach((cb) => cb());
}

async function request<T>(method: string, u: string, body?: unknown): Promise<T> {
  if (MOCK) {
    const { mockFetch } = await import("./mock");
    return mockFetch(method, u, body) as Promise<T>;
  }
  const init: RequestInit = { method, headers: { ...auth } };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json", ...auth };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(u, init);
  if (r.status === 401) reportAuthLost();
  if (!r.ok) {
    let detail = "";
    try {
      const d = (await r.json())?.detail;
      detail = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x?.msg ?? "").join("; ") : "";
    } catch { /* not JSON */ }
    throw new ApiError(r.status, detail || `${u} → ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export const j = <T>(u: string): Promise<T> => request<T>("GET", u);
export const jpost = <T>(u: string, body: unknown = {}): Promise<T> => request<T>("POST", u, body);
export const jpatch = <T>(u: string, body: unknown): Promise<T> => request<T>("PATCH", u, body);
export const jput = <T>(u: string, body: unknown): Promise<T> => request<T>("PUT", u, body);
export const jdel = <T>(u: string): Promise<T> => request<T>("DELETE", u);

/** Base path of a profile-scoped endpoint: pp("jan", "/summary") -> /api/p/jan/summary. */
export const pp = (slug: string, path: string): string => `/api/p/${encodeURIComponent(slug)}${path}`;

// ---- platform shapes (system, modules, profiles, setup) --------------------
/** Keys of `/api/system` `secrets` (presence flags, never values). The backend test
 * `test_system_secret_keys_match_the_frontend_contract` checks this exact list. */
export const SECRET_KEYS = ["anthropic", "enable_banking_key"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export interface SystemInfo {
  version: string;
  data_dir: string;
  legacy_db_detected: boolean;
  legacy_db_path: string | null;
  worker: { installed: boolean; last_run: string | null };
  secrets?: Partial<Record<SecretKey, boolean>>;
}

export interface ModuleInfo { id: string; name: string; description: string; depends_on: string[]; available: boolean }

export type SetupState = "empty" | "partial" | "ready";
export type Privacy = "strict" | "amounts";

export interface ProfileModule { id: string; enabled: boolean; setup_state: SetupState }
export interface Profile {
  slug: string;
  name: string;
  base_currency: string;
  mcp_privacy: Privacy;
  modules: ProfileModule[];
}

export interface SetupAction { kind: string; label: string; target: string; disabled?: boolean; hint?: string }
export interface SetupStep {
  id: string;
  title: string;
  description: string;
  status: "done" | "on" | "todo";
  actions: SetupAction[];
}
export interface SetupInfo {
  state: SetupState;
  steps: SetupStep[];
  skill: { command: string; mcp_add: string } | null;
}

export const getSystem = () => j<SystemInfo>("/api/system");
export const getModules = () => j<ModuleInfo[]>("/api/modules");
export const getProfiles = () => j<Profile[]>("/api/profiles");
export const createProfile = (b: { name: string; base_currency: string; modules: string[]; mcp_privacy: Privacy }) =>
  jpost<Profile>("/api/profiles", b);
export const patchProfile = (slug: string, b: Partial<Pick<Profile, "name" | "base_currency" | "mcp_privacy">>) =>
  jpatch<Profile>(`/api/profiles/${encodeURIComponent(slug)}`, b);
export const putProfileModules = (slug: string, modules: string[]) =>
  jput<Profile>(`/api/profiles/${encodeURIComponent(slug)}/modules`, { modules });
export const getSetup = async (slug: string, moduleId: string): Promise<SetupInfo> => {
  const r = await j<Omit<SetupInfo, "skill"> & { skill?: SetupInfo["skill"] | string | null }>(
    pp(slug, `/modules/${encodeURIComponent(moduleId)}/setup`),
  );
  // Tolerate a bare skill command (ModuleSpec.skill) or a missing mcp_add line.
  const sk = r.skill;
  const skill = !sk ? null
    : typeof sk === "string" ? { command: sk, mcp_add: mcpAddCommand(slug) }
    : { command: sk.command, mcp_add: sk.mcp_add || mcpAddCommand(slug) };
  return { ...r, steps: r.steps ?? [], skill };
};

/** One MCP server per profile (design decision 4). */
export const mcpAddCommand = (slug: string) => `claude mcp add finanse-${slug} -- finanse mcp --profile ${slug}`;

// ---- shapes ----------------------------------------------------------------
export interface Breakdown {
  currency: string;
  assets: number;
  liabilities: number;
  net: number;
  property: number;
  mortgage: number;
  home_equity: number;
  by_type: Record<string, number>;
}

export interface Account {
  id: number;
  bank: string;
  name: string;
  type: string;
  currency: string;
  iban_tail: string;
  balance: number | null;
  as_of: string | null;
  is_liability: boolean;
}

export interface Summary {
  networth: Record<string, number>;
  breakdown: Breakdown;
  month: { label: string; income: number; expense: number; net: number } | null;
  // monthly_totals: per currency (never summed); monthly_total = PLN only (legacy)
  subscriptions: { count: number; monthly_total: number; monthly_totals: Record<string, number> };
}

export interface NetworthResp {
  totals: Record<string, number>;
  breakdown: Breakdown;
  accounts: Account[];
}

export interface SeriesPoint { date: string; value: number; components: Record<string, number> }
export interface SeriesComponent { key: string; label: string; liability: boolean }
// currency: the one currency of the series (default: the profile's base currency).
export interface SeriesResp { currency?: string; points: SeriesPoint[]; components: SeriesComponent[] }
export interface Category { key: string; label: string; kind: string }

export interface CashTxn {
  id: number;
  date: string;
  amount: number;
  title: string;
  category: string;
  category_label: string;
  kind: "withdrawal" | "expense";
}

export interface CashResp {
  exists: boolean;
  account_id?: number;
  currency: string;
  balance: number;
  withdrawals: number;
  expenses: number;
  transactions: CashTxn[];
}

export interface ResyncResp {
  ok: boolean;
  error?: string;
  inserted?: number;
  banks?: { bank: string; inserted: number; accounts: number }[];
  pairs?: number;
  errors?: string[];
}

// ---- core endpoints (profile-scoped) ---------------------------------------
export const getSummary = (slug: string) => j<Summary>(pp(slug, "/summary"));
export const getNetworth = (slug: string) => j<NetworthResp>(pp(slug, "/networth"));
export const getSeries = (slug: string, granularity: string, scope: string) =>
  j<SeriesResp>(pp(slug, `/networth/series?granularity=${granularity}&scope=${scope}`));
export const getCash = (slug: string) => j<CashResp>(pp(slug, "/cash"));
export const postCashExpense = (slug: string, b: { amount: number; title: string; category: string }) =>
  jpost<{ ok?: boolean; id?: number; error?: string }>(pp(slug, "/cash/expense"), b);
export const deleteCashTxn = (slug: string, id: number) => jdel<{ ok: boolean }>(pp(slug, `/cash/transaction/${id}`));
export const postResync = (slug: string) => jpost<ResyncResp>(pp(slug, "/resync"));

// categories are static for a session - fetch once per profile, memoized.
const _cats = new Map<string, Promise<Category[]>>();
export const getCategories = (slug: string): Promise<Category[]> => {
  let p = _cats.get(slug);
  if (!p) {
    p = j<Category[]>(pp(slug, "/categories"));
    p.catch(() => _cats.delete(slug));
    _cats.set(slug, p);
  }
  return p;
};
