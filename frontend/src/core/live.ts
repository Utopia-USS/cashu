// Live data (P10), pure part: typed change events pushed by the server (`GET /api/p/{slug}/changes/stream`, SSE;
// the fallback poll `GET /api/p/{slug}/changes?after=`), written by any process (an agent over MCP, the worker, the
// app itself). List rows (research notes, alerts, watchlist items, proposals) arrive with their wire dict and patch
// the cached lists in place, no request; derived views (segments, macro, thesis health, portfolio) re-read only the
// affected cache keys. The hook is core/useLive.ts. Tested in tests/live.test.mjs.

export interface LiveEvent {
  id: number;
  entity: "note" | "thesis" | "topic_thesis" | "segment_assignment" | "alert" | "watchlist" | "proposal" | "signal" | "prices" | "run" | string;
  op: "add" | "update" | "remove" | string;
  ref: string | null;
  /** The profile slug, null for shared data (prices) or a bulk change. */
  profile: string | null;
  /** `item`: the row's wire dict (list entities, add / update); `status`: a finished run's status. */
  payload: { item?: { id: number } & Record<string, unknown>; status?: string } | null;
}

/** The window's fallback poll while visible (the stream does the rest). */
export const LIVE_POLL_MS = 60_000;
/** Bursts of agent writes are applied together. */
export const LIVE_DEBOUNCE_MS = 500;

// ---- SSE parsing -------------------------------------------------------------------------------------------------
export interface SseFrame { event: string; data: string; id: string | null }

/** Complete frames of `buffer` (frames end with a blank line) and the incomplete rest. Comments (`: ...`) and
 * `retry:` lines are skipped. */
export function parseSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const text = buffer.replace(/\r\n/g, "\n");
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const part of parts) {
    let event = "message", id: string | null = null;
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (data.length) frames.push({ event, data: data.join("\n"), id });
  }
  return { frames, rest };
}

/** Reconnect delay after `failures` failed attempts in a row: 3 s doubling, at most 30 s. */
export const reconnectDelay = (failures: number): number => Math.min(30_000, 3000 * 2 ** Math.max(0, failures - 1));

// ---- cache keys (must match the views' keys: invKey = ck(slug, "inv", ...), src/swr.ts ck) --------------------------
const enc = (p: string | number) => encodeURIComponent(String(p));
const key = (slug: string, ...parts: (string | number)[]) => [slug, ...parts].map(enc).join("/");
const inv = (slug: string, ...parts: (string | number)[]) => key(slug, "inv", ...parts);
/** The cache prefix of every view of a profile. */
export const profileScope = (slug: string): string => enc(slug);

const PRICE_VIEWS = ["overview", "positions", "position", "chart", "perf", "watchlist"];

/** Cache prefixes a change makes stale (re-read in place); list rows patched by `listPatches` are not here. */
export function invalidations(slug: string, e: LiveEvent): string[] {
  const r = (...parts: string[]) => inv(slug, "research", ...parts);
  switch (e.entity) {
    case "note":
      return [r("summary"), r("candidates"), r("segments"), r("macro"), r("topic"), inv(slug, "watchlist")];
    case "thesis":
      return [inv(slug, "position"), inv(slug, "positions"), inv(slug, "instrument-theses"), r("summary"), r("segments")];
    case "topic_thesis":
      return [r("topic-thesis"), r("segments")];
    case "segment_assignment":
      return [r("segments"), r("summary"), inv(slug, "positions"), inv(slug, "watchlist")];
    case "alert":
      return [inv(slug, "watchlist"), inv(slug, "position"), ...(e.ref == null ? [inv(slug, "alerts")] : [])];
    case "watchlist":
      return [r("segments"), r("summary"), ...(e.ref == null ? [inv(slug, "watchlist")] : [])];
    case "proposal":
      return [key(slug, "proposals"), key(slug, "setup"), ...(e.ref == null ? [inv(slug, "proposals")] : [])];
    case "signal":
      return [inv(slug, "signals"), inv(slug, "digest"), inv(slug, "overview"), inv(slug, "position")];
    case "prices":
      return [...PRICE_VIEWS.map((v) => inv(slug, v)), r("segments"), r("macro"), key(slug, "summary"), key(slug, "networth"), key(slug, "series")];
    case "run":
      return e.op === "add" ? [] : [inv(slug), key(slug, "summary"), key(slug, "networth"), key(slug, "series")];
    default:
      return [profileScope(slug)];
  }
}

// ---- list patches ---------------------------------------------------------------------------------------------------
type Row = { id: number } & Record<string, unknown>;
export interface ListPatch { match: (key: string) => boolean; apply: (key: string, data: unknown) => unknown }

/** `list` with `item` put in place of the row with its id, or added (`front`: newest first), or removed when `keep`
 * says it does not belong to the list; undefined when nothing changes (or the data is not a list). */
export function upsert(list: unknown, item: Row, keep: boolean, front = false): unknown {
  if (!Array.isArray(list)) return undefined;
  const i = list.findIndex((x) => (x as Row)?.id === item.id);
  if (!keep) return i < 0 ? undefined : list.filter((_, j) => j !== i);
  if (i >= 0) return list.map((x, j) => (j === i ? item : x));
  return front ? [item, ...list] : [...list, item];
}

export function removeId(list: unknown, id: number): unknown {
  if (!Array.isArray(list)) return undefined;
  return list.some((x) => (x as Row)?.id === id) ? list.filter((x) => (x as Row)?.id !== id) : undefined;
}

const today = () => new Date().toISOString().slice(0, 10);
const expired = (n: Row, day: string) => n.expired === true || (typeof n.expires_at === "string" && n.expires_at.slice(0, 10) < day);
const dismissed = (n: Row) => !!n.dismissed_at;

/** Investments proposal kinds (core/connectors.ts INV_PROPOSAL_KINDS). */
const INV_KINDS = new Set(["strategy", "custom_rule", "rule", "import"]);

/** Which cached list keys an event patches and how (the key's own filter decides add vs remove). */
export function listPatches(slug: string, e: LiveEvent, day = today()): ListPatch[] {
  const ref = e.ref == null ? NaN : Number(e.ref);
  if (Number.isNaN(ref)) return [];
  const item = e.payload?.item ?? null;
  const exact = (k: string) => (x: string) => x === k;
  const patch = (match: (k: string) => boolean, keep: (row: Row, k: string) => boolean, front = false): ListPatch => ({
    match,
    apply: (k, data) => (e.op === "remove" || !item ? removeId(data, ref) : upsert(data, item, keep(item, k), front)),
  });
  switch (e.entity) {
    case "watchlist":
      return [patch(exact(inv(slug, "watchlist")), () => true)];
    case "alert":
      return [patch(exact(inv(slug, "alerts", "all")), () => true)];
    case "proposal":
      return [patch(exact(inv(slug, "proposals", "pending")), (p) => p.status === "pending" && INV_KINDS.has(String(p.kind)), true)];
    case "note": {
      const notes = inv(slug, "research", "notes");
      const byInstrument = inv(slug, "research", "instrument");
      const byTopic = inv(slug, "research", "topic");
      return [
        patch((k) => k.startsWith(`${notes}/`), (n, k) => {
          const which = decodeURIComponent(k.slice(notes.length + 1));
          if (which === "all") return true;
          if (which === "live") return !expired(n, day);
          return !dismissed(n) && !expired(n, day); // "default": the strip's list
        }, true),
        patch((k) => k.startsWith(`${byInstrument}/`), (n, k) => String(n.instrument_id) === decodeURIComponent(k.slice(byInstrument.length + 1)), true),
        patch((k) => k.startsWith(`${byTopic}/`), (n, k) => String(n.segment ?? "") === decodeURIComponent(k.slice(byTopic.length + 1)), true),
      ];
    }
    default:
      return [];
  }
}

// ---- batching -------------------------------------------------------------------------------------------------------
export interface Timers { set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void }
const realTimers: Timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/** Collects items and flushes them together `ms` after the first one of a burst (a later one does not postpone it
 * past `ms`, so a steady stream still lands every half second). */
export function createBatcher<T>(flush: (items: T[]) => void, ms = LIVE_DEBOUNCE_MS, timers: Timers = realTimers) {
  let items: T[] = [];
  let timer: unknown = null;
  const run = () => { timer = null; const out = items; items = []; if (out.length) flush(out); };
  return {
    push(...more: T[]) {
      items.push(...more);
      if (timer === null) timer = timers.set(run, ms);
    },
    flushNow() { if (timer !== null) timers.clear(timer); run(); },
    cancel() { if (timer !== null) timers.clear(timer); timer = null; items = []; },
  };
}

/** Events newer than `lastId`, once each, in id order (the stream and the fallback poll may both deliver one). */
export function fresh(events: LiveEvent[], lastId: number | null): LiveEvent[] {
  return events.filter((e) => lastId == null || e.id > lastId).sort((a, b) => a.id - b.id);
}

/** The run state a `run` event sets: `add` = started, `update` = finished with its status. */
export function runStateOf(e: LiveEvent): { running: boolean; status: string | null } | null {
  if (e.entity !== "run") return null;
  return e.op === "add" ? { running: true, status: null } : { running: false, status: e.payload?.status ?? null };
}
