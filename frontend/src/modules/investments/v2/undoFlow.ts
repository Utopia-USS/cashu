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
