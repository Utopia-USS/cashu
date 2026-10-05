// Undo flows on top of FX's undo.ts (F5 R4): one toast with "Cofnij" that runs the server-side undo once,
// retries a failed request, says "za późno" after the 15-minute window; and the alert delete undo through
// BE's restore endpoint (F6 owner decision 2: delete with undo, the restore keeps the id). Pure apart from
// the API calls passed in (tested in tests/investments-f6.test.mjs).
import { makeUndo, type Undo, undoMessage, undoSettled } from "../undo.ts";

type Toast = (text: string, ms?: number, action?: { label: string; onClick: () => void }) => void;

/** Toast `text` with "Cofnij" for `u`; after the undo: `onDone` and "Cofnięto: what" (+ `note()` when it
 * returns a line; a failed request offers "Cofnij" again, an expired, gone or refused one does not). */
export function offerUndo(toast: Toast, text: string, u: Undo, what: string, onDone: () => void, ms = 10000, note?: () => string | null): void {
  const retry = () => {
    void u.undo().then((res) => {
      if (undoSettled(res)) onDone();
      const extra = res === "done" ? note?.() ?? null : null;
      const msg = extra ? `${undoMessage(res, what)} · ${extra}` : undoMessage(res, what);
      if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
    });
  };
  toast(text, ms, { label: "Cofnij", onClick: retry });
}

/** A server without the endpoint answers 404 / 405 without a code (FastAPI's own "Not Found"). */
export function isMissingEndpoint(e: unknown): boolean {
  const x = (typeof e === "object" && e !== null ? e : {}) as { status?: unknown; code?: unknown };
  return (x.status === 404 || x.status === 405) && !x.code;
}

/** Undo of a deleted alert: the restore (same id, `POST alerts/{id}/restore` within 15 minutes); a server
 * without the restore endpoint gets the F5 fallback, a re-created copy (new id). Other errors propagate
 * (a 409 `undo_expired` is read by makeUndo as "too late"). */
export async function restoreOrRecreate(restore: () => Promise<unknown>, recreate: () => Promise<unknown>): Promise<"restored" | "recreated"> {
  try {
    await restore();
    return "restored";
  } catch (e) {
    if (!isMissingEndpoint(e)) throw e;
    await recreate();
    return "recreated";
  }
}

/** The fields of a deleted alert that re-create it (the fallback only). */
export function recreateInput<A extends {
  kind: string; title: string; params: Record<string, unknown>; instrument_id: number | null; scope: string; polarity: string; severity: string;
  note: string | null; cooldown_days: number | null; expires_at: string | null;
}>(a: A) {
  return {
    kind: a.kind, title: a.title, params: a.params, instrument_id: a.instrument_id, scope: a.scope, polarity: a.polarity, severity: a.severity,
    note: a.note, cooldown_days: a.cooldown_days, expires_at: a.expires_at,
  };
}

/** Undo object for a deleted alert (saved now). */
export function alertDeleteUndo(restore: () => Promise<unknown>, recreate: () => Promise<unknown>, now: () => number = Date.now): Undo {
  return makeUndo(now(), () => restoreOrRecreate(restore, recreate), now);
}

// ---- undo by re-creating (watchlist remove, F7 fix pass F6) ------------------------------------------------

/** The watchlist has no server-side undo: "Cofnij" POSTs the item again, so the outcome is the POST's own
 * (no 15-minute window): 409 = it is already on the list again (e.g. the agent re-added it), 404 = the
 * instrument is gone, another 4xx is final, network / 5xx / 408 / 429 can be retried. */
export type RecreateResult = "done" | "busy" | "already" | "exists" | "missing" | "refused" | "failed";

export function makeRecreate(run: () => Promise<unknown>): { undo(): Promise<RecreateResult>; readonly error: unknown } {
  let state: "ready" | "running" | "settled" = "ready";
  let error: unknown = null;
  return {
    get error() { return error; },
    async undo(): Promise<RecreateResult> {
      if (state === "running") return "busy";
      if (state === "settled") return "already";
      state = "running";
      try {
        await run();
        state = "settled";
        return "done";
      } catch (e) {
        error = e;
        const status = typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
        if (typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          state = "settled";
          return status === 409 ? "exists" : status === 404 || status === 410 ? "missing" : "refused";
        }
        state = "ready";
        return "failed";
      }
    },
  };
}

/** Toast text after a re-create undo; `detail` = the Polish error text of the failed POST. */
export function recreateMessage(result: RecreateResult, what: string, detail: string): string | null {
  switch (result) {
    case "done": return `Cofnięto: ${what}`;
    case "exists": return "Już na liście";
    case "missing": return `Nie przywrócono: ${detail}`;
    case "refused": return `Nie przywrócono: ${detail}`;
    case "failed": return `Nie udało się cofnąć: ${what} - spróbuj jeszcze raz`;
    default: return null;
  }
}

/** The list changed on the server after this result (refresh the view). */
export const recreateSettled = (r: RecreateResult): boolean => r === "done" || r === "exists";

/** Toast `text` with "Cofnij" that re-creates the item (see makeRecreate); a failed request offers it again. */
export function offerRecreate(toast: Toast, text: string, run: () => Promise<unknown>, what: string, onDone: () => void,
  describe: (e: unknown) => string, ms = 10000, note?: () => string | null): void {
  const u = makeRecreate(run);
  const retry = () => {
    void u.undo().then((res) => {
      if (recreateSettled(res)) onDone();
      const base = recreateMessage(res, what, describe(u.error));
      const extra = res === "done" ? note?.() ?? null : null;
      const msg = base && extra ? `${base} · ${extra}` : base;
      if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
    });
  };
  toast(text, ms, { label: "Cofnij", onClick: retry });
}
