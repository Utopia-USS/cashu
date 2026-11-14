// ab24ab6 v2/undoFlow.ts: undo flows on top of undo.ts (F5 R4): one toast with "Cofnij" that runs the server-side
// undo once, retries a failed request, says "za późno" after the 15-minute window; the alert delete undo through
// the restore command (the restore keeps the id); the watchlist re-create undo. Pure apart from the writes passed
// in. The native host always has the alert restore, so the old re-create fallback of a deleted alert is gone.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/undoFlow.strings";
import { makeUndo, type Undo, undoMessage, undoSettled } from "./undo.js";

export type Toast = (
  text: string,
  ms?: number,
  action?: { label: string; onClick: () => void },
) => void;

/** Toast `text` with "Cofnij" for `u`; after the undo: `onDone` and "Cofnięto: what" (+ `note()` when it
 * returns a line; a failed request offers "Cofnij" again, an expired, gone or refused one does not). */
export function offerUndo(
  toast: Toast,
  text: string,
  u: Undo,
  what: string,
  onDone: () => void,
  ms = 10000,
  note?: () => string | null,
): void {
  const retry = () => {
    void u.undo().then((res) => {
      if (undoSettled(res)) onDone();
      const extra = res === "done" ? (note?.() ?? null) : null;
      const msg = extra ? `${undoMessage(res, what)} · ${extra}` : undoMessage(res, what);
      if (msg)
        toast(
          msg,
          res === "failed" ? 8000 : 3000,
          res === "failed" ? { label: C.undo, onClick: retry } : undefined,
        );
    });
  };
  toast(text, ms, { label: C.undo, onClick: retry });
}

/** Undo object for a deleted alert (saved now): the restore within 15 minutes (a refused `undo_expired` is read
 * by makeUndo as "too late"). */
export function alertDeleteUndo(
  restore: () => Promise<unknown>,
  now: () => number = Date.now,
): Undo {
  return makeUndo(now(), restore, now);
}

// ---- undo by re-creating (watchlist remove, F7 fix pass F6) ------------------------------------------------

/** The watchlist has no server-side undo: "Cofnij" adds the item again, so the outcome is the add's own (no
 * 15-minute window): 409 = it is already on the list again (e.g. the agent re-added it), 404 = the instrument is
 * gone, another 4xx is final, a write that never reached the host can be retried. */
type RecreateResult = "done" | "busy" | "already" | "exists" | "missing" | "refused" | "failed";

function makeRecreate(run: () => Promise<unknown>): {
  undo(): Promise<RecreateResult>;
  readonly error: unknown;
} {
  let state: "ready" | "running" | "settled" = "ready";
  let error: unknown = null;
  return {
    get error() {
      return error;
    },
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
        const status =
          typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
        if (
          typeof status === "number" &&
          status >= 400 &&
          status < 500 &&
          status !== 408 &&
          status !== 429
        ) {
          state = "settled";
          return status === 409
            ? "exists"
            : status === 404 || status === 410
              ? "missing"
              : "refused";
        }
        state = "ready";
        return "failed";
      }
    },
  };
}

/** Toast text after a re-create undo; `detail` = the error text of the failed add. */
function recreateMessage(result: RecreateResult, what: string, detail: string): string | null {
  switch (result) {
    case "done":
      return S.undone(what);
    case "exists":
      return S.alreadyListed;
    case "missing":
      return S.notRestored(detail);
    case "refused":
      return S.notRestored(detail);
    case "failed":
      return S.undoFailed(what);
    default:
      return null;
  }
}

/** The list changed on the server after this result (refresh the view). */
const recreateSettled = (r: RecreateResult): boolean => r === "done" || r === "exists";

/** Toast `text` with "Cofnij" that re-creates the item (see makeRecreate); a failed request offers it again. */
export function offerRecreate(
  toast: Toast,
  text: string,
  run: () => Promise<unknown>,
  what: string,
  onDone: () => void,
  describeError: (e: unknown) => string,
  ms = 10000,
  note?: () => string | null,
): void {
  const u = makeRecreate(run);
  const retry = () => {
    void u.undo().then((res) => {
      if (recreateSettled(res)) onDone();
      const base = recreateMessage(res, what, describeError(u.error));
      const extra = res === "done" ? (note?.() ?? null) : null;
      const msg = base && extra ? `${base} · ${extra}` : base;
      if (msg)
        toast(
          msg,
          res === "failed" ? 8000 : 3000,
          res === "failed" ? { label: C.undo, onClick: retry } : undefined,
        );
    });
  };
  toast(text, ms, { label: C.undo, onClick: retry });
}
