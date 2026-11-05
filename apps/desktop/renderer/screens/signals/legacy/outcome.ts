// The bridge between the native write outcomes and the old request errors the ported undo / toast logic reads
// (undo.ts `undoFailure`, undoFlow.ts `makeRecreate`, Alerts.tsx `describeError`): a refusal becomes an error with
// the HTTP status the Python route answered for it (409 too late / already there, 404 gone, 400 refused) and the
// translated reason as its message; an outcome that never reached the host or stayed unknown has no status (the
// old network error: worth a retry).
import { label } from "@cashu/ui-logic/core/messages";
import { O } from "../../CommandOutcome.strings.js";
import { commandFailure, type GuardedOutcome } from "../../useDurableCommand.js";

/** A UI action's answer (store-react useUiAction). */
export type ActionOutcome<R> =
  | { readonly status: "completed"; readonly value: R }
  | { readonly status: "refused" | "not_started"; readonly reason: string }
  | { readonly status: "outcome_unknown" };

const STATUS: Readonly<Record<string, number>> = {
  undo_expired: 409,
  already_watched: 409,
  no_decision: 404,
  no_alert: 404,
  no_item: 404,
  no_instrument: 404,
  no_signal: 404,
};

export class OutcomeError extends Error {
  readonly status: number | undefined;
  readonly code: string | null;
  constructor(message: string, reason: string | null) {
    super(message);
    this.code = reason;
    this.status = reason === null ? undefined : (STATUS[reason] ?? 400);
  }
}

/** The text of a refusal reason (`error.<reason>`), else the generic outcome line. */
const reasonText = (reason: string, fallback: string): string =>
  label(`error.${reason}`) ?? fallback;

/** The failure of a command outcome as an error (null when it completed). */
function commandError<R>(r: GuardedOutcome<R>): OutcomeError | null {
  if (r.kind === "completed") return null;
  const text = commandFailure(r);
  return r.kind === "refused"
    ? new OutcomeError(reasonText(r.reason, text), r.reason)
    : new OutcomeError(text, null);
}

/** The failure of a UI action outcome as an error (null when it completed). */
function actionError<R>(r: ActionOutcome<R>): OutcomeError | null {
  if (r.status === "completed") return null;
  if (r.status === "outcome_unknown") return new OutcomeError(O.unknown, null);
  if (r.status === "not_started") return new OutcomeError(O.unavailable, null);
  return new OutcomeError(reasonText(r.reason, O.refused), r.reason);
}

/** Resolves the command's value, throws its failure (the old api.ts request). */
export async function settled<R>(run: Promise<GuardedOutcome<R>>): Promise<R> {
  const r = await run;
  if (r.kind === "completed") return r.value;
  throw commandError(r);
}

/** Resolves the UI action's value, throws its failure. */
export async function settledAction<R>(run: Promise<ActionOutcome<R>>): Promise<R> {
  const r = await run;
  if (r.status === "completed") return r.value;
  throw actionError(r);
}

/** The old `errorText(e)`: the message of a failed write. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
