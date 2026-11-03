// S60's connector-backed budget_import boundary. Python checks the binding, device-local approved
// connector code and cursor/base_ok_at BEFORE touching staged bytes. Their native proposal
// binding/run-id mapping is an explicit open contract (genesis/rewrite.ts), not permission to skip
// those checks or to invent a synced machine approval. This validator never reads a blob or writes.
import { z } from "zod";
import { type CommandRefusal, refuse } from "../command.js";
import type { ExecutionSnapshot } from "../core/proposal-execution.js";
import { accountByMemberGid } from "../core/queries.js";
import { blobRef, gid } from "../events/v1/primitives.js";
import type { Read } from "../query.js";

const payloadSchema = z.looseObject({
  account: gid,
  blob: blobRef,
  file_name: z.string().min(1),
  file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.literal("connector"),
});

/** Validate native metadata/target ownership, then explicitly refuse the unresolved connector gate. */
export function prepareBudgetImport(read: Read, snapshot: ExecutionSnapshot): CommandRefusal {
  if (snapshot.kind !== "budget_import") return refuse("wrong_kind");
  if (snapshot.status !== "pending") return refuse("not_pending");
  const parsed = payloadSchema.safeParse(snapshot.payload);
  if (!parsed.success) return refuse("invalid_payload");
  if (parsed.data.file_sha256 !== parsed.data.blob.sha256) return refuse("staged_changed");
  if (accountByMemberGid(read, parsed.data.account) === undefined) return refuse("no_account");
  return refuse("connector_binding_unsupported");
}
