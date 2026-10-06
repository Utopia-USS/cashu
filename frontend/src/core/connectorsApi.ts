// Connectors (F10, design/v3/connectors section 9): the global install registry and approval
// (`/api/connectors`, not profile-scoped: a connector is code, not data) and the profile's fetch bindings
// (`/api/p/{slug}/connectors/bindings`). Transport only; the pure helpers live in core/connectors.ts.
import { ApiError, authHeaders, handle401, j, jdel, jpost, jput, pp, responseError } from "./api";

export type ConnectorStatus = "pending" | "approved" | "changed" | "disabled";
export type ConnectorModule = "investments" | "budget";
export type ConnectorKind = "file" | "fetch";

export interface ConnectorLastRun { outcome: string; error_kind: string | null; command: string; started_at: string | null }

/** `GET /api/connectors` item (`summary_dict`); `description`, `extensions`, `timeout_s` arrive with contract C2. */
export interface ConnectorSummary {
  id: string;
  name: string;
  version: string;
  author: string | null;
  module: ConnectorModule | string;
  kind: ConnectorKind | string;
  status: ConnectorStatus | string;
  source: "cli" | "mcp" | string;
  content_sha256: string;
  interpreter_path: string | null;
  installed_at: string | null;
  updated_at: string | null;
  approved_at: string | null;
  /** Bindings in every profile. */
  bindings: number;
  last_run: ConnectorLastRun | null;
  description?: string | null;
  extensions?: string[];
  timeout_s?: number;
  /** A `disabled` connector whose files (or interpreter) differ from the approved ones (FE-5 contract); false otherwise. */
  content_changed?: boolean;
}

export interface ConnectorFile { path: string; size: number; sha256: string; executable?: boolean }
export interface ConnectorParam { id: string; label: string; type?: "string" | "date" | "number" | "boolean" | string; required?: boolean }
export interface ConnectorSecret { id: string; label: string }

/** A recorded run (owner view; the redacted stderr tail is shown only in the app, never to MCP). */
export interface ConnectorRun {
  id: number;
  command: string;
  started_at: string | null;
  duration_ms: number | null;
  outcome: string;
  error_kind: string | null;
  exit_code?: number | null;
  records: number | null;
  denied_hosts: string[] | null;
  stderr_tail: string | null;
  profile?: string | null;
  profile_id?: number | null;
  binding_id?: number | null;
  proposal_id?: number | null;
  batch_ref?: string | null;
}

/** `GET /api/connectors/{id}` (`detail_dict`). */
export interface ConnectorDetail extends ConnectorSummary {
  description: string | null;
  run: string[] | null;
  timeout_s: number;
  extensions: string[];
  hosts: string[];
  secrets: ConnectorSecret[];
  params: ConnectorParam[];
  history_days: number | null;
  files: ConnectorFile[];
  missing: boolean;
  problems: string[];
  approved_sha256: string | null;
  approved_interpreter: string | null;
  interpreter_changed: boolean;
  /** Filled for `changed` and for a `disabled` connector with `content_changed`. */
  diff: { added: string[]; removed: string[]; modified: string[] } | null;
  recent_runs?: ConnectorRun[];
}

/** A run answered by `check` / `sync` (`run_dict`). */
export interface RunDict {
  run_id: number | null;
  command: string;
  outcome: string;
  ok: boolean;
  error_kind: string | null;
  message: string | null;
  duration_ms: number | null;
  records: number | null;
  denied_hosts: string[] | null;
  stderr_tail?: string | null;
}

/** `binding_dict` (`account_label` arrives with contract C9). */
export interface Binding {
  id: number;
  account_id: number;
  connector_id: string;
  connector_name: string;
  connector_status: string;
  module: string;
  params: Record<string, unknown> | null;
  auto_commit: boolean;
  has_cursor: boolean;
  has_commit: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_ok_at: string | null;
  backoff_until: string | null;
  secrets: ConnectorSecret[];
  secrets_set: string[];
  account_label?: string | null;
}

export interface SyncResult {
  binding_id?: number;
  connector_name?: string;
  /** The bound account's label. */
  account?: string | null;
  /** `pending_exists` (BE-2): a previous result of this binding still waits; nothing ran (`run: null`), `proposal_id`
   * and `preview` are the waiting proposal's. */
  outcome?: "synced" | "pending_exists" | string;
  run: RunDict | null;
  since?: string | null;
  preview: { new: number; duplicates: number; warnings: number; blocking?: number | boolean } | null;
  proposal_id: number | null;
  committed: { inserted: number; duplicates: number; batch_id: number | string | null } | null;
  /** A blocking problem (nothing stored, the cursor stays): `import_failed`, `import_blocked`, a connector code. */
  problem?: { code: string; message: string } | null;
}

const C = "/api/connectors";
const cid = (id: string) => `${C}/${encodeURIComponent(id)}`;
/** A relative path inside the connector dir, each segment encoded (the route takes `{relpath:path}`). */
const rel = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const getConnectors = () => j<ConnectorSummary[]>(C);
export const getConnector = (id: string) => j<ConnectorDetail>(cid(id));

/** The last runs (contract C6); a server without the route: the detail's `recent_runs`. */
export async function getConnectorRuns(id: string, limit = 20): Promise<ConnectorRun[]> {
  try {
    return await j<ConnectorRun[]>(`${cid(id)}/runs?limit=${limit}`);
  } catch (e) {
    // an older server without the route answers FastAPI's plain 404 (no error code)
    if (e instanceof ApiError && (e.status === 404 || e.status === 405) && !e.code) {
      return (await getConnector(id)).recent_runs ?? [];
    }
    throw e;
  }
}

/** A text response (the code viewer and the diff are plain text, not JSON). */
async function text(u: string): Promise<{ text: string; type: string }> {
  const r = await fetch(u, { headers: await authHeaders() });
  if (r.status === 401) handle401();
  if (!r.ok) throw await responseError(r, u);
  return { text: await r.text(), type: r.headers.get("Content-Type") ?? "" };
}

/** A text file of the installed connector (<= 200 KiB; 415 binary, 413 too large). */
export const getConnectorFile = async (id: string, path: string): Promise<string> => (await text(`${cid(id)}/files/${rel(path)}`)).text;

/** The unified diff of one file against the approved copy (a `changed` connector). Plain text, or JSON
 * `{diff: "..."}` from a server that wraps it. */
export async function getConnectorDiff(id: string, path: string): Promise<string> {
  const r = await text(`${cid(id)}/diff/${rel(path)}`);
  if (r.type.includes("json")) {
    try {
      const d = JSON.parse(r.text) as unknown;
      if (typeof d === "string") return d;
      if (d && typeof d === "object") {
        const o = d as Record<string, unknown>;
        const v = o.diff ?? o.unified ?? o.text;
        if (typeof v === "string") return v;
      }
    } catch { /* keep the raw text */ }
  }
  return r.text;
}

export const postConnectorApprove = (id: string, body: { content_sha256: string; interpreter_path: string | null }) =>
  jpost<ConnectorSummary>(`${cid(id)}/approve`, body);
export const postConnectorDisable = (id: string) => jpost<ConnectorSummary>(`${cid(id)}/disable`, {});
export const deleteConnector = (id: string) => jdel<{ ok: boolean; bindings: number; secrets_left: number }>(cid(id));

// ---- per profile: fetch bindings ---------------------------------------------------------------

const B = (slug: string, path = "") => pp(slug, `/connectors/bindings${path}`);

export const getBindings = (slug: string) => j<Binding[]>(B(slug));
export const postBinding = (slug: string, body: {
  connector_id: string; account_id: number; params: Record<string, unknown>; secrets?: Record<string, string>; auto_commit?: boolean;
}) => jpost<Binding>(B(slug), body);
export const putBinding = (slug: string, id: number, body: { params?: Record<string, unknown>; auto_commit?: boolean }) =>
  jput<Binding>(B(slug, `/${id}`), body);
/** Write-only: a value sets, null clears; the answer lists only which ids are set. */
export const putBindingSecrets = (slug: string, id: number, secrets: Record<string, string | null>) =>
  jput<{ secrets_set: string[] }>(B(slug, `/${id}/secrets`), { secrets });
export const postBindingCheck = (slug: string, id: number) => jpost<RunDict>(B(slug, `/${id}/check`), {});
export const postBindingSync = (slug: string, id: number) => jpost<SyncResult>(B(slug, `/${id}/sync`), {});
/** `secrets_left`: keychain entries the server could not delete (reported, never raised). */
export const deleteBinding = (slug: string, id: number) => jdel<{ ok: boolean; secrets_left?: number }>(B(slug, `/${id}`));
