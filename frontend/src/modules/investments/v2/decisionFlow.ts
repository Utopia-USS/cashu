// The one decision per position (asset-detail.md 7.2, F9) as a pure decision tree, without React or transport:
// the position endpoint first; on an older server (FastAPI's own 404 / 405) the home's fan-out (the decision on
// the primary signal, `decyzja: <tag>` acknowledgements on the rest), which needs at least one open signal. A
// fan-out that fails midway keeps what was saved (one undo for those ids). `useDecisionWriter` (Signals.tsx)
// maps the outcome to toasts; `npm test` covers it (tests/asset-detail.test.mjs).

type Write = () => Promise<{ decision: { id: number } }>;

export type DecisionOutcome =
  /** Saved: one position decision, or every fan-out step. */
  | { kind: "saved"; ids: number[]; legacy: boolean }
  /** Older server, the fan-out failed after some steps: those stay (with their undo). */
  | { kind: "partial"; ids: number[]; error: unknown; legacy: true }
  /** Older server and no open signal: nothing can be saved there. */
  | { kind: "needs-signal"; legacy: true }
  /** Nothing saved. */
  | { kind: "failed"; error: unknown; legacy: boolean };

export async function writePositionDecision(o: {
  /** The server is already known to lack the position endpoint (this session). */
  legacy: boolean;
  /** `POST /positions/{id}/decision` with every signal id. */
  post: Write;
  /** The fan-out steps (primary decision first); empty without open signals. */
  fanOut: Write[];
  isMissingRoute: (e: unknown) => boolean;
}): Promise<DecisionOutcome> {
  let legacy = o.legacy;
  if (!legacy) {
    try {
      return { kind: "saved", ids: [(await o.post()).decision.id], legacy: false };
    } catch (e) {
      if (!o.isMissingRoute(e)) return { kind: "failed", error: e, legacy: false };
      legacy = true;
    }
  }
  if (!o.fanOut.length) return { kind: "needs-signal", legacy: true };
  const ids: number[] = [];
  for (const step of o.fanOut) {
    try { ids.push((await step()).decision.id); } catch (e) {
      return ids.length ? { kind: "partial", ids, error: e, legacy: true } : { kind: "failed", error: e, legacy: true };
    }
  }
  return { kind: "saved", ids, legacy: true };
}

/** A save refused because the open signals changed meanwhile (the list is cached): 409 a signal closed, 422 a
 * signal of another instrument. The caller reloads the page data and shows this line; null for anything else. */
export function staleSignalText(e: unknown): string | null {
  const x = (typeof e === "object" && e !== null ? e : {}) as { status?: number; message?: string };
  if (x.status === 409) return "Sygnał już zamknięty";
  if (x.status === 422 && /not about instrument/i.test(x.message ?? "")) return "Sygnał dotyczy innego instrumentu";
  return null;
}
