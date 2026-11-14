// The file-system port of the folder transport. `packages/sync` runs on Node, Electron and Hermes
// without platform imports, so the app wires an implementation at its root (Node `fs` on the desktop,
// a future iOS ubiquity-container module, risk R7). Paths are relative, `/`-separated, and never
// contain `..`; the implementation resolves them under the synced folder's root.
//
// Errors: when the folder itself cannot be reached (volume unmounted, the root missing, permission
// lost) every method MUST reject with `TransportError("unavailable")`, so the engine counts the
// remote as offline instead of mistaking it for an empty vault. Anything else may propagate.

export interface FolderEntry {
  readonly name: string;
  readonly kind: "file" | "dir";
  /** Size in bytes (files; 0 for directories). */
  readonly size: number;
}

export interface FolderFs {
  /** Entries of a directory, or `undefined` when it does not exist. */
  list(path: string): Promise<readonly FolderEntry[] | undefined>;
  /** Bytes from `offset` to the current end, or `undefined` when the file does not exist. */
  read(path: string, offset: number): Promise<Uint8Array | undefined>;
  /**
   * Create or truncate `path` with `bytes` and flush it to stable storage (fsync) before resolving.
   * Parent directories are created as needed. Only ever called on temporary names.
   */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Atomically replace `to` with `from` (POSIX rename within one directory). */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file; resolves when it is already gone. */
  remove(path: string): Promise<void>;
  /** Optional change notification for anything below `path` (recursive). Returns the unsubscribe. */
  watch?(path: string, onChange: () => void): () => void;
}
