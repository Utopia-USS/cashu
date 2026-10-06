// Typed client over the FastAPI backend. No business logic here - just
// transport + shapes mirroring the JSON the server returns. Profile-scoped
// endpoints live under /api/p/{slug}/...; module endpoints are in
// modules/<id>/api.ts and use the same transport.

// Per-launch API token: never in the served page (PK1). core/token.ts gets it from the desktop
// bridge, the `#token=` fragment `cashu serve` prints, or this tab's sessionStorage; under
// `npm run dev` the Vite proxy adds the header itself (see vite.config.ts).
import { clearCache } from "../swr";
import type { ModuleSyncLine } from "./connectors";
import { apiToken, forgetToken, NO_TOKEN_TEXT } from "./token";

/** The token header for a request (`{}` under `npm run dev`); throws a 401 ApiError with a Polish
 * explanation when this page has no token at all. Multipart uploads use it too. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await apiToken();
  if (token === null) throw new ApiError(401, NO_TOKEN_TEXT, "auth.no_token");
  return token ? { "X-Cashu-Token": token } : {};
}

// Dev-only demo backend (`VITE_MOCK=1 npm run dev`). Off by default; the mock
// module is only loaded when the flag is set at build time.
const MOCK = import.meta.env.VITE_MOCK === "1";

/** Error with the server's `detail` message when it sent one (FastAPI style) and the stable code of the
 * `X-Cashu-Error-Code` header (the detail stays English; core/messages.ts `errorText` shows the Polish
 * label of the code). */
export class ApiError extends Error {
  /** `body`: the parsed `detail` when it is an object (a connector run failure: kind, message, stderr_tail,
   * timeout_s, connector), else null. */
  constructor(readonly status: number, message: string, readonly code: string | null = null, readonly body: unknown = null) { super(message); }
}

/** The ApiError of a failed response: a string `detail` is the message; an object `detail` is kept as `body`
 * (its `message` becomes the message); FastAPI validation lists join their `msg`s. */
export async function responseError(r: Response, u: string): Promise<ApiError> {
  let detail = "";
  let body: unknown = null;
  try {
    const d = (await r.json())?.detail;
    if (typeof d === "string") detail = d;
    else if (Array.isArray(d)) detail = d.map((x) => x?.msg ?? "").join("; ");
    else if (d && typeof d === "object") {
      body = d;
      const m = (d as { message?: unknown }).message;
      detail = typeof m === "string" ? m : "";
    }
  } catch { /* not JSON */ }
  return new ApiError(r.status, detail || `${u} → ${r.status}`, r.headers.get("X-Cashu-Error-Code"), body);
}

// A 401 means this page's token is no longer valid: `cashu serve` was restarted (new token
// per launch). The stale token is dropped (core/token.ts) and the app shows one notice (App.tsx)
// instead of an error in every view; the browser then needs the new URL `cashu serve` printed.
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
/** A 401 answer of any request (JSON or multipart upload): drop the token and the cached data (F7 PX2),
 * show the one notice. */
export function handle401(): void {
  forgetToken();
  clearCache();
  reportAuthLost();
}

async function request<T>(method: string, u: string, body?: unknown): Promise<T> {
  if (MOCK) {
    const { mockFetch } = await import("./mock");
    return mockFetch(method, u, body) as Promise<T>;
  }
  const auth = await authHeaders();
  const init: RequestInit = { method, headers: { ...auth } };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json", ...auth };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(u, init);
  if (r.status === 401) handle401();
  if (!r.ok) throw await responseError(r, u);
  return r.json() as Promise<T>;
}

export const j = <T>(u: string): Promise<T> => request<T>("GET", u);
export const jpost = <T>(u: string, body: unknown = {}): Promise<T> => request<T>("POST", u, body);
export const jpatch = <T>(u: string, body: unknown): Promise<T> => request<T>("PATCH", u, body);
export const jput = <T>(u: string, body: unknown): Promise<T> => request<T>("PUT", u, body);
export const jdel = <T>(u: string): Promise<T> => request<T>("DELETE", u);

/** Multipart POST (a file upload) around the JSON helper: the same token header and error handling. */
export async function jupload<T>(u: string, body: FormData): Promise<T> {
  if (MOCK) {
    const { mockFetch } = await import("./mock");
    return mockFetch("POST", u, body) as Promise<T>;
  }
  const r = await fetch(u, { method: "POST", body, headers: await authHeaders() });
  if (r.status === 401) handle401();
  if (!r.ok) throw await responseError(r, u);
  return r.json() as Promise<T>;
}

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
  /** Background worker (track W contract; older servers send only installed + last_run). */
  worker: WorkerInfo;
  secrets?: Partial<Record<SecretKey, boolean>>;
  /** Connectors (F10): `sandbox` false = runs are refused on this platform (approval still possible). */
  connectors?: { sandbox: boolean; platform: string };
  /** F11: steps of the move from the pre-rename install that failed or were refused (core/migrate_legacy.py). */
  rename_migration?: { step: string; status: string; detail: string }[];
}

export interface WorkerJob {
  job: string; module: string | null; status: string; detail: string | null; last_run?: string | null;
  /** F7: stable outcome code (`worker.<code>` in messages.ts) + params; `profile` = slug of the first problem. */
  code?: string | null; params?: Record<string, unknown> | null; profile?: string | null;
}
export interface WorkerInfo {
  installed: boolean;
  last_run: string | null;
  label?: string | null;
  /** Daily run time "HH:MM" (local); the default the install would use when not installed. */
  schedule?: string | null;
  last_status?: string | null;
  next_run?: string | null;
  log_path?: string | null;
  platform?: string | null;
  supported?: boolean;
  job_path?: string | null;
  program?: string[] | null;
  jobs?: WorkerJob[];
  /** F7 PK11 / R8: the worker job or the MCP lines point at a program that moved or is gone. Two parts, each
   * null when fine; an older server sent one flat object (`worker` reason string + `app_moved_from`) or null. */
  relocation?: WorkerRelocation | LegacyRelocation | null;
}
export interface WorkerRelocation {
  /** The launchd job: cleared by POST /api/system/worker/install. */
  worker: { reason: "missing" | "other_program" | string; program?: string | null; expected_program?: string[] | null; actions: string[] } | null;
  /** The MCP lines (Claude Code / Desktop, workspace .mcp.json): cleared by POST /api/system/relocation/ack or a
   * workspace update that rewrote .mcp.json. */
  mcp: { reason: "app_moved" | string; app_moved_from: string; moved_at?: string | null; actions: string[] } | null;
}
/** The F7 PK11 shape before R8. */
export interface LegacyRelocation {
  worker: "missing" | "other_program" | null;
  expected_program?: string | null;
  app_moved_from?: string | null;
  actions: string[];
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
  /** Never counts toward the module state (e.g. the assets vehicle step, first-steps D8). */
  optional?: boolean;
}
export interface SetupInfo {
  state: SetupState;
  steps: SetupStep[];
  /** `translocated`: macOS App Translocation, `mcp_add` is a placeholder until the app is moved (PK3). */
  skill: { command: string; mcp_add: string; translocated?: boolean } | null;
  /** The CLI prefix of the profile (`cashu --profile jan`), for command lines shown in the app. */
  cli_prefix?: string | null;
}

export const getSystem = () => j<SystemInfo>("/api/system");
/** GET /api/system/update (core/updates.py): the running version vs `project.version` of pyproject.toml on
 * the configured GitHub branch. `url` is that branch's commit list; `error` is set when the check is off or
 * failed ("disabled" | "config" | "network" | "parse"), and then `available` is false. */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  checked_at: string;
  error: string | null;
}
export const getUpdate = () => j<UpdateInfo>("/api/system/update");
/** The owner re-added the MCP server after the app moved (F7 R8): clears `relocation.mcp`. */
export const postRelocationAck = () => jpost<{ worker: WorkerInfo }>("/api/system/relocation/ack");
/** Background worker actions (track W): install / uninstall the launchd agent, run once now. */
export const postWorker = (action: "install" | "uninstall" | "run", body: { time?: string; offline?: boolean } = {}) =>
  jpost<{ worker: WorkerInfo; run?: { status: string; summary?: WorkerJob[] } }>(`/api/system/worker/${action}`, body);

/** One MCP tool call of a profile (track M audit log, Settings > Agent AI): `{id, tool, privacy,
 * called_at, args (names + JSON types only), outcome ok|error|refused, error_kind, duration_ms}`.
 * Older field names are read too (`at`, `privacy_level`, `status`). */
export interface McpCall {
  id?: number;
  called_at?: string | null;
  outcome?: string | null;
  error_kind?: string | null;
  args?: Record<string, unknown> | null;
  at?: string | null;
  created_at?: string | null;
  tool: string;
  privacy?: string | null;
  privacy_level?: string | null;
  args_summary?: string | null;
  arguments?: string | null;
  status?: string | null;
  result?: string | null;
  result_summary?: string | null;
  duration_ms?: number | null;
  error?: string | null;
}
export const getMcpCalls = async (slug: string, limit = 50): Promise<McpCall[] | null> => {
  try {
    const r = await j<McpCall[] | { items: McpCall[] }>(pp(slug, `/mcp/calls?limit=${limit}`));
    return Array.isArray(r) ? r : r.items ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null; // track M not landed: no log yet
    throw e;
  }
};
/** GET /api/p/{slug}/mcp: the profile's MCP server lines (the packaged app points them at its own binary). */
export interface McpInfo {
  server_name: string;
  command: string;
  claude_mcp_add: string;
  /** Claude Desktop server entry: goes under mcpServers[server_name]. */
  claude_desktop?: { command: string; args: string[] };
  packaged?: boolean;
  /** macOS App Translocation: the snippets are placeholders until the app is moved (PK3). */
  translocated?: boolean;
}
export const getMcpInfo = (slug: string) => j<McpInfo>(pp(slug, "/mcp"));
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
    : { command: sk.command, mcp_add: sk.mcp_add || mcpAddCommand(slug), translocated: !!sk.translocated };
  return { ...r, steps: r.steps ?? [], skill };
};

/** One MCP server per profile (design decision 4). */
export const mcpAddCommand = (slug: string) => `claude mcp add cashu-${slug} -- cashu mcp --profile ${slug}`;

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
  /** Budget fetch-connector bindings synced with it (F10): present only when the profile has some. */
  connectors?: ModuleSyncLine[];
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

// FastAPI's own 404 / 405 for a route the server does not have (an older server): pure, in its own module so
// `npm test` can import it (this file uses a TS class parameter property node cannot strip).
export { isMissingRoute } from "./missingRoute";
