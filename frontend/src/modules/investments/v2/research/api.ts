// Research API client (F6 spec "Research layer", track RS CONTRACT in stock/docs/fork/progress/F6-RS.md;
// implementation-plan Wave F item 28). Endpoints under /api/p/{slug}/investments/research…, the profile
// workspace (track AW) and the watchlist for accepted candidates. A server without the research layer
// answers 404: the runs read as "never ran" so no research UI shows (density rule), nothing breaks.
import { ApiError, j, jdel, jpatch, jpost, pp } from "../../../../core/api";
import type { ResearchNote, ResearchRun, ResearchSummary, Workspace } from "./types";

const inv = (slug: string, path: string) => pp(slug, `/investments${path}`);
/** A server without the research layer: FastAPI's generic 404 / 405 (a missing profile keeps its error). */
const missing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405) && !/profile/i.test(e.message);

export interface NoteQuery {
  instrument?: number | string | null;
  theme?: string | null;
  kind?: string | null;
  since?: string | null;
  include_dismissed?: boolean;
  include_expired?: boolean;
  limit?: number;
}

function qs(q: NoteQuery): string {
  const p = new URLSearchParams();
  if (q.instrument != null) p.set("instrument", String(q.instrument));
  if (q.theme) p.set("theme", q.theme);
  if (q.kind) p.set("kind", q.kind);
  if (q.since) p.set("since", q.since);
  if (q.include_dismissed) p.set("include_dismissed", "true");
  if (q.include_expired) p.set("include_expired", "true");
  if (q.limit) p.set("limit", String(q.limit));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** A list endpoint may answer a bare array or `{notes|items|runs: [...]}`. */
function list<T>(r: unknown, key: string): T[] {
  if (Array.isArray(r)) return r as T[];
  const o = (r ?? {}) as Record<string, unknown>;
  const v = o[key] ?? o.items;
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Notes with fields the UI relies on present (sources array, numeric strength). */
export function normNote(n: ResearchNote): ResearchNote {
  return {
    ...n,
    sources: Array.isArray(n.sources) ? n.sources : [],
    strength: Number(n.strength) || 1,
    summary: n.summary ?? "",
    theme: n.theme ?? null,
    instrument_id: n.instrument_id ?? (n.instrument ? Number(n.instrument.id) : null),
  };
}

export const getResearch = async (slug: string, q: NoteQuery = {}): Promise<ResearchNote[]> => {
  try { return list<ResearchNote>(await j<unknown>(inv(slug, `/research${qs(q)}`)), "notes").map(normNote); }
  catch (e) { if (missing(e)) return []; throw e; }
};

export const getResearchSummary = async (slug: string): Promise<ResearchSummary | null> => {
  try {
    const s = await j<ResearchSummary>(inv(slug, "/research/summary"));
    return { ...s, instruments: s.instruments ?? [], themes: s.themes ?? [] };
  } catch (e) { if (missing(e)) return null; throw e; }
};

export const getResearchRuns = async (slug: string): Promise<ResearchRun[]> => {
  try { return list<ResearchRun>(await j<unknown>(inv(slug, "/research/runs")), "runs"); }
  catch (e) { if (missing(e)) return []; throw e; }
};

/** Dismiss a note (resolves the signal it created, server side; design answer 1). */
export const dismissNote = (slug: string, id: number) => jpatch<ResearchNote>(inv(slug, `/research/${id}`), { dismissed: true });
/** Undo a dismissal within the server's 15-minute window. */
export const restoreNote = (slug: string, id: number) => jpatch<ResearchNote>(inv(slug, `/research/${id}`), { dismissed: false });

export interface AcceptResult { note: ResearchNote; watchlist_item: { id: number } | null; thesis: { id: number } | null; created_instrument?: boolean; warnings?: string[] }

/** `Obserwuj` on a candidate: the watchlist row (source user, `kandydat: <title>`) and a draft thesis with
 * the candidate's entry type (design answer 4), in one server call (RS CONTRACT 3). */
export const acceptCandidate = (slug: string, id: number) => jpost<AcceptResult>(inv(slug, `/research/${id}/accept`), {});
/** Undo of `Obserwuj` within 15 minutes: removes the watchlist row and the untouched draft thesis. */
export const unacceptCandidate = (slug: string, id: number) => jdel<ResearchNote>(inv(slug, `/research/${id}/accept`));

/** Profile agent workspace (track AW): path + whether it exists; null on servers without it. */
export const getWorkspace = async (slug: string): Promise<Workspace | null> => {
  try {
    const w = await j<Record<string, unknown>>(pp(slug, "/workspace"));
    const path = typeof w.path === "string" ? w.path : null;
    const exists = typeof w.exists === "boolean" ? w.exists : !!path;
    const skills = Array.isArray(w.skills) ? (w.skills as { name: string; state: string }[]) : null;
    const mr = skills?.find((s) => s.name === "market-research");
    const skill_installed = !exists ? false : skills ? !!mr && ["ok", "outdated", "modified"].includes(mr.state) : null;
    return { ...w, path, exists, skill_installed, skill_installed_at: skill_installed && typeof w.updated_at === "string" ? w.updated_at : null } as Workspace;
  } catch (e) { if (missing(e)) return null; throw e; }
};

/** Mark the profile's unread agent notes of an instrument, a theme or a list read (F8 BE, Q10): idempotent;
 * the agent never marks read. A server without the endpoint answers 404: nothing is marked, nothing breaks. */
export const postResearchRead = async (slug: string, body: { instrument_id: number } | { theme: string } | { ids: number[] }): Promise<{ marked: number }> => {
  try { return await jpost<{ marked: number }>(inv(slug, "/research/read"), body); }
  catch (e) { if (missing(e)) return { marked: 0 }; throw e; }
};
