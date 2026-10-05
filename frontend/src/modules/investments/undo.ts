// Undo of a change that was saved at once (F5 R4): a decision, an acknowledgement, a snooze or a
// "review done" is written to the server immediately; the toast's "Cofnij" calls the server-side undo
// (DELETE /decisions/{id}, snooze until null, DELETE /reviews/{id}). Nothing waits for a timer, the
// page visibility or an unload, so nothing can be lost or silently kept. Pure module (tested in
// tests/undo.test.mjs).
import { parseServerTime } from "../../time.ts";

/** How long the server accepts an undo (store/journal.py UNDO_WINDOW, core/reviews.py UNDO_WINDOW). */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

/** ready: can be undone; running: the undo request is in flight; done: undone (or found already undone);
 * expired: too late; refused: the server refused it for good (no "Cofnij" again). */
export type UndoState = "ready" | "running" | "done" | "expired" | "refused";
/** gone: the server no longer has the change (404 / 410: undone in another window or by the agent);
 * refused: another final 4xx (400, 401, 403, 422); failed: network / 5xx / 408 / 429, can be retried. */
export type UndoResult = "done" | "expired" | "failed" | "busy" | "already" | "gone" | "refused";

export interface Undo {
  readonly state: UndoState;
  /** Run the server-side undo at most once (one undo per saved change). A failed request (network,
   * 5xx) leaves it ready so the owner can try again; a 409 from the server means the window passed; a 404
   * means it is already undone; other 4xx are final (F7 FE15: no endless "Cofnij"). */
  undo(): Promise<UndoResult>;
}

/** `savedAt` = when the server confirmed the save (ms); `run` = the undo request. */
export function makeUndo(savedAt: number, run: () => Promise<unknown>, now: () => number = Date.now): Undo {
  let state: UndoState = "ready";
  return {
    get state() { return state; },
    async undo(): Promise<UndoResult> {
      if (state === "running") return "busy";
      if (state === "done") return "already";
      if (state === "refused") return "refused";
      if (state === "expired" || now() - savedAt > UNDO_WINDOW_MS) { state = "expired"; return "expired"; }
      state = "running";
      try {
        await run();
        state = "done";
        return "done";
      } catch (e) {
        const kind = undoFailure(e);
        if (kind === "expired") { state = "expired"; return "expired"; }
        if (kind === "gone") { state = "done"; return "gone"; }
        if (kind === "refused") { state = "refused"; return "refused"; }
        state = "ready";
        return "failed";
      }
    },
  };
}

/** A saved decision (a real id, not the overlay of one being saved) still inside the undo window. */
export function canUndo(d: { id: number; created_at: string | null }, now: number = Date.now()): boolean {
  if (!(d.id > 0) || !d.created_at) return false;
  const saved = parseServerTime(d.created_at);
  return Number.isFinite(saved) && now - saved <= UNDO_WINDOW_MS;
}

/** The server refused the undo because the window passed (409 undo_expired). */
export function isExpired(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: number }).status === 409;
}

/** How a failed undo request ends: 409 too late, 404 / 410 already gone, another 4xx refused for good,
 * anything else (no status = network, 5xx, 408, 429) worth a retry. */
export function undoFailure(e: unknown): "expired" | "gone" | "refused" | "retry" {
  const status = typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
  if (typeof status !== "number") return "retry";
  if (status === 409) return "expired";
  if (status === 404 || status === 410) return "gone";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "refused";
  return "retry";
}

/** The change is no longer pending on the server after this result (refresh the view). */
export const undoSettled = (r: UndoResult): boolean => r === "done" || r === "gone";

/** Toast text after an undo attempt (null: nothing to say, e.g. a second click). */
export function undoMessage(result: UndoResult, what: string): string | null {
  switch (result) {
    case "done": return `Cofnięto: ${what}`;
    case "expired": return `Za późno na cofnięcie (${UNDO_WINDOW_MS / 60000} minut minęło) - ${what} zostaje zapisane`;
    case "failed": return `Nie udało się cofnąć: ${what} - spróbuj jeszcze raz`;
    case "gone": return `Już cofnięte: ${what}`;
    case "refused": return `Nie da się cofnąć: ${what}`;
    default: return null;
  }
}
