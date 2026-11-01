// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1); it goes
// away with the Python app.
//
// Public API of the outbox bridge (S31a spec 2.1, 11): Python outbox rows -> catalog events per
// linked vault, built on the genesis mappers (one owner of the Python-row -> event semantics), and
// the ack plan back to Python. Platform free and clock free (randomness and the leader question
// come in through `BridgePorts`), so the lab daemon and later the desktop utility process run the
// same code. Exported as the package subpath `@cashu/store/bridge` (lab / desktop hosts only).
export { type Coverage, coverage, type TableCoverage } from "./coverage.js";
export { type CushionShip, cushionShip } from "./cushion.js";
export { readLiveRows } from "./live.js";
export { BridgeBlock } from "./map/types.js";
export type { LogicalRow } from "./merge.js";
export {
  atOf,
  byTxn,
  completeTxns,
  type OutboxRow,
  outboxRowSchema,
} from "./outbox.js";
export {
  type AckEntry,
  ackEntries,
  type CarriedColumns,
  FRAME_BYTES,
  FRAME_EVENTS,
  type Plan,
  type PlanCounts,
  type PlanInput,
  type PlanResult,
  plan,
  type VaultBatch,
} from "./plan.js";
export type { AckGid, BridgePorts, CurrentRows, VaultInput } from "./resolve.js";
