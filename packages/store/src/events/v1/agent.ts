// Reviews, proposals and connector bindings payloads (events.md 8.10).
import { z } from "zod";
import { empty, payload } from "./helpers.js";
import { gid, jsonObject, nonEmpty, timestamp, ulid } from "./primitives.js";

export const PROPOSAL_KINDS = ["strategy", "custom_rule", "import", "budget_import"] as const;

/** Proposal payloads use gids and blob refs: a local `account_id` or a `staged` path is rejected. */
const proposalPayload = jsonObject.refine((p) => !("account_id" in p) && !("staged" in p), {
  message: "proposal payload must use `account` (gid) and `blob` instead of account_id / staged",
});

export const agentEvents = {
  "review.done": payload({
    module: z.string().regex(/^[a-z][a-z0-9_]*$/),
    doneAt: timestamp.optional(),
    notes: z.string().nullable(),
    stats: jsonObject,
  }),
  "review.undone": empty,

  "proposal.created": payload({
    kind: z.enum(PROPOSAL_KINDS),
    summary: z.string(),
    reason: z.string().nullable(),
    payload: proposalPayload,
    source: nonEmpty,
  }),
  "proposal.approved": payload({ result: jsonObject }),
  "proposal.rejected": payload({ note: z.string().nullable() }),
  "proposal.failed": payload({ result: jsonObject }),
  /**
   * The approved change could not be completed after the decision (Python `_finish`: the strategy
   * files could not be written, the recorded version is undone). `approval` is the eid of the
   * `proposal.approved` event this failure reports. GUARD: only while that approval is the applied
   * (winning) decision, status approved -> failed with this result; it revokes exactly that
   * approval's caused side effects (events.md 6.6). A losing approver's failure changes nothing.
   */
  "proposal.applyFailed": payload({ result: jsonObject, approval: ulid }),

  "connectorBinding.set": payload({
    account: gid,
    connectorId: nonEmpty,
    params: jsonObject,
    autoCommit: z.boolean(),
  }),
  "connectorBinding.removed": empty,
  /**
   * The fetch cursor a committed connector fetch advanced to (M5): emitted by the lease holder in the
   * approval / auto-commit batch with `cause`, so a suppressed approval rolls the cursor back too.
   */
  "connectorBinding.cursorAdvanced": payload({ cursor: z.string().nullable() }),
} as const;
