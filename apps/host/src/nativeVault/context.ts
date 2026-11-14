// What every part of one open native vault session shares: the opened resources and the session's
// mutable authority state. Built once by openNativeVault after recovery succeeded.
import type { SqlDriver, Store } from "@cashu/store";
import type { SqlProvenanceStore } from "@cashu/store/sync";
import type { FolderTransport, SyncEngine } from "@cashu/sync";
import type { SqlAttemptJournal } from "../attemptJournal.js";
import type { WriterLease } from "../lease.js";
import type { PairingJournal } from "../pairing/journal.js";
import type { WriteQueue } from "../queue.js";
import type {
  DeviceAuthorityCandidate,
  NativeVaultInventoryEntry,
} from "../sync/keys/deviceAuthority.js";
import type { NativeVaultSource } from "./types.js";

/** Mutable session authority. `current` only ever goes from true to false. */
interface SessionState {
  current: boolean;
  syncing: boolean;
  activeFetches: number;
}

export interface NativeVaultContext {
  readonly entry: NativeVaultInventoryEntry;
  readonly dataDir: string;
  /** The vault root folder (`entry.vaultRoot`). */
  readonly root: string;
  readonly source: NativeVaultSource;
  readonly lease: WriterLease;
  readonly now: () => number;
  readonly meta: SqlDriver;
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly candidate: DeviceAuthorityCandidate;
  readonly attempts: SqlAttemptJournal;
  readonly provenance: SqlProvenanceStore;
  readonly pairingJournal: PairingJournal;
  readonly localTransport: FolderTransport;
  readonly certificates: readonly Uint8Array[];
  readonly queue: WriteQueue;
  readonly state: SessionState;
}

/** The single profile gid of the view, undefined unless exactly one profile row exists. */
export function profileGid(store: Store): string | undefined {
  const rows = store.read<{ gid: string }>("SELECT gid FROM profiles");
  return rows.length === 1 ? rows[0]?.gid : undefined;
}

/** Ends this session's authority: nothing new is admitted; a reopen is required. */
export function failClosed(context: NativeVaultContext): void {
  context.state.current = false;
  context.queue.close();
}
