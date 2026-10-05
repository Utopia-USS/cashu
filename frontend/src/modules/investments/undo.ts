// Undo of a change that was saved at once (F5 R4): a decision, an acknowledgement, a snooze or a
// "review done" is written to the server immediately; the toast's "Cofnij" calls the server-side undo
// (DELETE /decisions/{id}, snooze until null, DELETE /reviews/{id}). Nothing waits for a timer, the
// page visibility or an unload, so nothing can be lost or silently kept. Pure module (tested in
// tests/undo.test.mjs).

/** How long the server accepts an undo (store/journal.py UNDO_WINDOW, core/reviews.py UNDO_WINDOW). */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

/** ready: can be undone; running: the undo request is in flight; done: undone; expired: too late. */
export type UndoState = "ready" | "running" | "done" | "expired";
export type UndoResult = "done" | "expired" | "failed" | "busy" | "already";

export interface Undo {
  readonly state: UndoState;
  /** Run the server-side undo at most once (one undo per saved change). A failed request (network,
   * 5xx) leaves it ready so the owner can try again; a 409 from the server means the window passed. */
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
      if (state === "expired" || now() - savedAt > UNDO_WINDOW_MS) { state = "expired"; return "expired"; }
      state = "running";
      try {
        await run();
        state = "done";
        return "done";
      } catch (e) {
        if (isExpired(e)) { state = "expired"; return "expired"; }
        state = "ready";
        return "failed";
      }
    },
  };
}

/** A saved decision (a real id, not the overlay of one being saved) still inside the undo window. */
export function canUndo(d: { id: number; created_at: string | null }, now: number = Date.now()): boolean {
  if (!(d.id > 0) || !d.created_at) return false;
  const saved = Date.parse(d.created_at);
  return Number.isFinite(saved) && now - saved <= UNDO_WINDOW_MS;
}

/** The server refused the undo because the window passed (409 undo_expired). */
export function isExpired(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: number }).status === 409;
}

/** Toast text after an undo attempt (null: nothing to say, e.g. a second click). */
export function undoMessage(result: UndoResult, what: string): string | null {
  switch (result) {
    case "done": return `Cofnięto: ${what}`;
    case "expired": return `Za późno na cofnięcie (${UNDO_WINDOW_MS / 60000} minut minęło) - ${what} zostaje zapisane`;
    case "failed": return `Nie udało się cofnąć: ${what} - spróbuj jeszcze raz`;
    default: return null;
  }
}
