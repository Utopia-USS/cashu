// The vault's import batch list on its own: the screen facts and the review read it without the import
// pipeline the preview needs (Metro bundles whole files, the phone does not tree-shake).
import type { Read } from "./shared.js";

/** The vault's import batches, newest first (Python `GET /imports`). */
export interface ImportBatchView {
  readonly gid: string;
  readonly account: string;
  readonly importer: string;
  readonly broker: string;
  readonly fileName: string;
  readonly fileSha256: string;
  /** The archived file's blob key `<sha256>.<ext>` (D9), null when the batch archived nothing. */
  readonly archive: string | null;
  readonly txnCount: number;
  readonly duplicateCount: number;
  readonly positionCount: number;
  readonly renameCount: number;
  readonly statusChangeCount: number;
  readonly instrumentCount: number;
  readonly correctionCount: number;
  readonly warnings: readonly unknown[];
  readonly createdAt: string;
}

export function importBatches(read: Read): ImportBatchView[] {
  return read<{
    gid: string;
    account: string;
    importer: string;
    broker: string;
    file_name: string;
    file_sha256: string;
    archive_path: string | null;
    txn_count: number;
    duplicate_count: number;
    position_count: number;
    rename_count: number;
    status_change_count: number;
    instrument_count: number;
    correction_count: number;
    warnings: string;
    created_at: string;
  }>(
    `SELECT b.gid, a.gid AS account, b.importer, b.broker, b.file_name, b.file_sha256, b.archive_path,
       b.txn_count, b.duplicate_count, b.position_count, b.rename_count, b.status_change_count,
       b.instrument_count, b.correction_count, b.warnings, b.created_at
     FROM inv_import_batches b JOIN accounts a ON a.id = b.account_id
     ORDER BY b.created_at DESC, b.id DESC`,
  ).map((r) => ({
    gid: r.gid,
    account: r.account,
    importer: r.importer,
    broker: r.broker,
    fileName: r.file_name,
    fileSha256: r.file_sha256,
    archive: r.archive_path,
    txnCount: r.txn_count,
    duplicateCount: r.duplicate_count,
    positionCount: r.position_count,
    renameCount: r.rename_count,
    statusChangeCount: r.status_change_count,
    instrumentCount: r.instrument_count,
    correctionCount: r.correction_count,
    warnings: JSON.parse(r.warnings) as unknown[],
    createdAt: r.created_at,
  }));
}
