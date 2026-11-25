// Test support: the old two-step import service (Python `service/imports.py` + the API's staging).
// A preview stages the uploaded file until it is committed; the commit archives the file FIRST, then
// runs `commitImport`, which re-previews the staged file against the view and writes everything as
// one batch, and finally drops the staged copy. The import tests drive the import semantics through
// it; the shipped app imports through agent proposals (services/import-proposals.ts).
import { type CommandEnv, type EventWriter, runCommand } from "../../../command.js";
import { accountByMemberGid } from "../../../core/queries.js";
import type { Store } from "../../../materialize.js";
import { archiveExtension, type CommitResult, commitImport } from "../../commands/imports.js";
import {
  type ImportPreview,
  type ImportRequest,
  previewImport,
} from "../../queries/import-preview.js";
import type { Read } from "../../queries/shared.js";
import type { ImportArchive } from "../imports.js";

/** The device-local holding area of previewed uploads. */
export interface ImportStaging {
  put(sha256: string, ext: string, content: Uint8Array): Promise<void>;
  get(sha256: string, ext: string): Promise<Uint8Array | null>;
  remove(sha256: string, ext: string): Promise<void>;
}

export interface ImportServiceDeps {
  readonly store: Store;
  readonly staging: ImportStaging;
  readonly archive: ImportArchive;
  readonly writer: EventWriter;
  readonly env: CommandEnv;
}

export type StagedPreview =
  | {
      readonly ok: true;
      readonly preview: ImportPreview;
      /** What the commit names the staged file by (its sha256). */
      readonly fileId: string;
    }
  | { readonly ok: false; readonly reason: "no_account" | "file_too_large" | "empty_file" };

/** `POST import/preview`: the preview (read-only), then the upload staged until it is committed. */
export async function previewAndStage(
  deps: Pick<ImportServiceDeps, "store" | "staging" | "env">,
  request: ImportRequest,
): Promise<StagedPreview> {
  if (request.file.content.length === 0) return { ok: false, reason: "empty_file" };
  const now = new Date(deps.env.clock.now()).toISOString();
  const read: Read = (sql, ...p) => deps.store.read(sql, ...p);
  const account = accountByMemberGid(read, request.account)?.gid ?? request.account;
  const result = previewImport(read, { ...request, account }, now);
  if (!result.ok) return result;
  const ext = archiveExtension(request.file.name);
  // A connector import stages its converted document: the commit never runs the connector again.
  await deps.staging.put(result.preview.sha256, ext, request.file.content);
  return { ok: true, preview: result.preview, fileId: result.preview.sha256 };
}

export interface CommitRequest extends Omit<ImportRequest, "file"> {
  readonly fileId: string;
  readonly fileName: string;
  /** Instrument ids (planned or stored gids) of the preview's reconciliation to correct. */
  readonly corrections?: readonly string[];
}

export type CommitOutcome =
  | { readonly ok: true; readonly result: CommitResult }
  | { readonly ok: false; readonly reason: string };

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * `POST import/commit`: the staged file, archived first, then committed in one batch; the staged copy
 * is removed after a successful commit. A refused commit leaves the archive (blob GC removes an
 * unreferenced one) and the staged copy (pruned after a day).
 */
export async function commitStaged(
  deps: ImportServiceDeps,
  request: CommitRequest,
): Promise<CommitOutcome> {
  if (!SHA256.test(request.fileId)) return { ok: false, reason: "invalid_file_id" };
  if (!deps.env.lease.isHolder()) return { ok: false, reason: "not_leader" };
  const ext = archiveExtension(request.fileName);
  const content = await deps.staging.get(request.fileId, ext);
  if (!deps.env.lease.isHolder()) return { ok: false, reason: "not_leader" };
  if (content === null) return { ok: false, reason: "no_staged_file" };
  // Python never archives a file whose re-preview cannot commit: check before the blob is written
  // (the command checks again against the view it writes to).
  const read: Read = (sql, ...p) => deps.store.read(sql, ...p);
  const account = accountByMemberGid(read, request.account)?.gid ?? request.account;
  const checked = previewImport(
    read,
    { ...request, account, file: { name: request.fileName, content } },
    new Date(deps.env.clock.now()).toISOString(),
  );
  if (!checked.ok) return checked;
  if (!checked.preview.canCommit) return { ok: false, reason: "cannot_commit" };
  const archive = await deps.archive.put(content, ext);
  const out = runCommand(
    deps.store,
    deps.writer,
    commitImport,
    {
      account: request.account,
      file: { name: request.fileName, content },
      importer: request.importer ?? "auto",
      mappingYaml: request.mappingYaml ?? null,
      connectorName: request.connectorName ?? null,
      requested: request.requested ?? null,
      boundAccount: request.boundAccount ?? false,
      corrections: [...(request.corrections ?? [])],
      archive: { sha256: archive.sha256, ext: archive.ext },
    },
    deps.env,
  );
  if (!out.ok) return out;
  await deps.staging.remove(request.fileId, ext);
  return { ok: true, result: out.value };
}
