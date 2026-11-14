// S60: prepare an already-staged ordinary import without opening a path or running a converter.
// Only the injected, vault-bound encrypted-blob adapter performs I/O. The actual import and
// approval are composed by core's executor into one batch; this service never appends separately.
import { sha256Hex } from "@cashu/domain";
import { MAX_FILE_BYTES } from "@cashu/domain/investments/importing";
import { z } from "zod";
import { type CommandContext, type CommandResult, ok, refuse } from "../../command.js";
import {
  type ExecutionSnapshot,
  type PreparedEffect,
  proposalExecution,
} from "../../core/proposal-execution.js";
import { accountByMemberGid } from "../../core/queries.js";
import { blobRef, gid } from "../../events/v1/primitives.js";
import type { Store } from "../../materialize.js";
import type { Read } from "../../query.js";
import { archiveExtension, type CommitResult, commitImport } from "../commands/imports.js";
import { isConnectorChoice, previewImport } from "../queries/import-preview.js";
import { brokerageAccount } from "../queries/transactions.js";
import type { BlobRef } from "./imports.js";

export interface ProposalImportBlobs {
  /** Decrypt only this vault's blob, aborting the read at maxBytes; no path comes from the payload. */
  read(vault: string, blob: BlobRef, maxBytes: number): Promise<Uint8Array | null>;
}

export interface ImportProposalDeps {
  readonly store: Store;
  readonly blobs: ProposalImportBlobs;
  /** Real current fetch authority, never the host's placeholder command lease. */
  isHolder(vault: string): boolean;
  now(): number;
  /** Host-only checked connector gate, repeated at final queued approval reentry. */
  readonly connector?: {
    precheck(read: Read, binding: ConnectorImportBinding): boolean;
    check(ctx: CommandContext, binding: ConnectorImportBinding): boolean;
  };
}

export interface ConnectorImportBinding {
  readonly id: string;
  readonly profileId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly module: "investments";
  readonly baseCursor: string | null;
  readonly paramsDigest: string;
  readonly approvedCodeDigest: string;
  readonly interpreter: string;
  readonly newCursor: string | null;
}

const connectorBindingSchema = z.strictObject({
  id: gid,
  profileId: z.string().regex(/^[a-f0-9]{32}$/),
  accountId: gid,
  connectorId: z.string().min(1),
  module: z.literal("investments"),
  baseCursor: z.string().nullable(),
  paramsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  approvedCodeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  interpreter: z.string().min(1),
  newCursor: z.string().nullable(),
});

const payloadSchema = z.looseObject({
  account: gid,
  blob: blobRef,
  file_name: z.string().min(1),
  file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  importer: z.string().nullable().optional(),
  mapping_yaml: z.string().nullable().optional(),
  connector_name: z.string().nullable().optional(),
  source: z.string().optional(),
  connector_binding: connectorBindingSchema.optional(),
});

/** Python's truth test for legacy JSON converter values, without interpreting/running them. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "" || value === 0)
    return false;
  if (Array.isArray(value)) return value.length !== 0;
  if (typeof value === "object") return Object.keys(value).length !== 0;
  return true;
}

/**
 * `investments_proposals._import_apply`: validate the pending proposal, re-read and hash its stored
 * bytes, then re-preview. Connector-origin imports stop before blob I/O: their binding/run identity
 * and D7 code-approval contract is not representable yet (genesis/rewrite.ts proposalPayload).
 */
export async function prepareInvestmentImport(
  deps: ImportProposalDeps,
  snapshot: ExecutionSnapshot,
): Promise<CommandResult<PreparedEffect<CommitResult>>> {
  if (snapshot.kind !== "import") return refuse("wrong_kind");
  if (snapshot.status !== "pending") return refuse("not_pending");
  const vault = deps.store.vault;
  const isHolder = deps.isHolder.bind(deps);
  const holder = () => {
    try {
      return isHolder(vault);
    } catch {
      return false;
    }
  };
  if (!holder()) return refuse("not_leader");
  const fingerprint = JSON.stringify(snapshot.payload);
  const current = proposalExecution(deps.store.read.bind(deps.store), snapshot.gid);
  if (
    current?.kind !== "import" ||
    current.status !== "pending" ||
    JSON.stringify(current.payload) !== fingerprint
  )
    return refuse("proposal_changed");
  if (truthy(snapshot.payload.converter)) return refuse("converter_unsupported");
  if ("binding_id" in snapshot.payload || "run_id" in snapshot.payload)
    return refuse("connector_binding_unsupported");
  const parsed = payloadSchema.safeParse(snapshot.payload);
  if (!parsed.success) return refuse("invalid_payload");
  const payload = parsed.data;
  const connector = payload.source === "connector" ? payload.connector_binding : undefined;
  if (payload.source === "connector" && (!connector || !deps.connector))
    return refuse("connector_binding_unsupported");
  if (payload.source !== "connector" && payload.connector_binding) return refuse("invalid_payload");
  // Only a connector run may record `connector:<id>` as the batch's importer (an ordinary proposal
  // carrying one, e.g. synced from another device, would be booked as that connector's import).
  if (payload.source !== "connector" && isConnectorChoice(payload.importer))
    return refuse("invalid_payload");
  if (
    connector &&
    (connector.profileId !== vault ||
      connector.accountId !== payload.account ||
      payload.importer !== `connector:${connector.connectorId}`)
  )
    return refuse("connector_binding_changed");
  const blob = Object.freeze({ sha256: payload.blob.sha256, ext: payload.blob.ext });
  if (blob.sha256 !== payload.file_sha256 || blob.ext !== archiveExtension(payload.file_name))
    return refuse("staged_changed");
  const read = deps.store.read.bind(deps.store);
  if (connector && !deps.connector?.precheck(read, connector))
    return refuse("connector_binding_changed");
  const root = accountByMemberGid(read, payload.account)?.gid ?? payload.account;
  if (brokerageAccount(read, root) === undefined) return refuse("no_account");
  // Capture method receivers, including class-backed vault/decryption providers.
  const readBlob = deps.blobs.read.bind(deps.blobs);
  let received: Uint8Array | null;
  try {
    received = await readBlob(vault, blob, MAX_FILE_BYTES);
  } catch {
    return refuse(holder() ? "blob_read_failed" : "not_leader");
  }
  if (!holder()) return refuse("not_leader");
  if (received === null) return refuse("staged_missing");
  if (!(received instanceof Uint8Array)) return refuse("invalid_blob");
  if (received.length > MAX_FILE_BYTES) return refuse("file_too_large");
  // The provider/caller cannot change approved bytes through a retained Uint8Array reference.
  const content = Uint8Array.from(received);
  if (sha256Hex(content) !== blob.sha256) return refuse("staged_changed");
  const checkedInput = commitImport.input.safeParse({
    account: payload.account,
    file: { name: payload.file_name, content },
    importer: payload.importer || "auto",
    mappingYaml: payload.mapping_yaml ?? null,
    connectorName: payload.connector_name ?? null,
    boundAccount: connector !== undefined,
    archive: blob,
  });
  if (!checkedInput.success) return refuse("invalid_payload");
  const input = checkedInput.data;
  const preview = previewImport(
    read,
    { ...input, account: root },
    new Date(deps.now()).toISOString(),
  );
  if (!preview.ok) return refuse(preview.reason);
  if (!preview.preview.canCommit) return refuse("import_blocked");
  return ok({
    proposalGid: snapshot.gid,
    kind: "import",
    recheck(ctx, fresh) {
      if (ctx.vault !== vault) return "wrong_vault";
      if (!holder() || !ctx.lease.isHolder()) return "not_leader";
      if (
        fresh.gid !== snapshot.gid ||
        fresh.kind !== "import" ||
        fresh.status !== "pending" ||
        JSON.stringify(fresh.payload) !== fingerprint
      )
        return "proposal_changed";
      const account = accountByMemberGid(ctx.read, input.account)?.gid ?? input.account;
      if (brokerageAccount(ctx.read, account) === undefined) return "no_account";
      if (connector && !deps.connector?.check(ctx, connector)) return "connector_binding_changed";
      return null;
    },
    apply(ctx) {
      if (ctx.vault !== vault) return refuse("wrong_vault");
      if (!holder()) return refuse("not_leader");
      if (connector && !deps.connector?.check(ctx, connector))
        return refuse("connector_binding_changed");
      // Re-preview/dedup uses the current queued view, not the earlier prepared preview's result.
      const result = commitImport.run(
        { ...ctx, lease: { isHolder: () => holder() && ctx.lease.isHolder() } },
        input,
      );
      if (result.ok && connector)
        ctx.emit("connectorBinding.cursorAdvanced", connector.id, { cursor: connector.newCursor });
      return result;
    },
    approvalResult(result) {
      return {
        batch_id: result.batch,
        inserted: result.inserted,
        duplicates: result.duplicates,
        positions: result.positions,
        new_instruments: result.newInstruments.length,
      };
    },
  });
}
