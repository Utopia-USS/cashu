import { MigrationError } from "./contract.js";
import { snapshotSqliteAndSideFilesOffline } from "./nativeSnapshot.js";
import {
  assertPrivateStagingSeal,
  assertSameSource,
  type PythonDatabaseName,
  type SourceSeal,
  sealPythonSource,
} from "./sourceSeal.js";

export interface FrozenSnapshot {
  readonly source: SourceSeal;
  readonly snapshot: SourceSeal;
}

/**
 * Copy an offline Python data dir into private staging. The caller must stop all Python processes
 * before invoking this function and keep them stopped until the import finishes. We check exact
 * source bytes and filesystem identity before and after the copy, and open SQLite only on the copy.
 */
export async function captureOfflineSnapshot(
  sourceRoot: string,
  privateDestination: string,
  database: PythonDatabaseName = "cashu.db",
): Promise<FrozenSnapshot> {
  try {
    const before = sealPythonSource(sourceRoot, database);
    await snapshotSqliteAndSideFilesOffline(sourceRoot, privateDestination, before, database);
    const after = sealPythonSource(sourceRoot, database);
    assertSameSource(before, after);
    const snapshot = sealPythonSource(privateDestination);
    assertPrivateStagingSeal(snapshot);
    return { source: before, snapshot };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("snapshot_unverified");
  }
}
