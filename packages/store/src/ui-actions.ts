/** An allowlisted async UI intent. Executable capabilities remain private to the host. */
export interface UiAction<I, R> {
  readonly id: string;
  /** Type-only input/output relationship; no value is serialized for this property. */
  readonly types?: { readonly input: I; readonly result: R };
}

/** Delivery outcome is separate from the action's own business outcome. */
export type UiActionResult<R> =
  | { readonly status: "completed"; readonly value: R }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly preparation: "none" | "retained";
    }
  | {
      readonly status: "outcome_unknown";
      readonly reason: "interrupted" | "unexpected_failure";
      readonly attempt?: { readonly key: string; readonly command: string };
    }
  | {
      readonly status: "not_started";
      readonly reason: "disconnected" | "capability_unavailable" | "pending_previous_attempt";
    };
