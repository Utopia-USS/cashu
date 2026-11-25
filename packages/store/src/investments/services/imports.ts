// The import archive port: committed imports are archived as encrypted content-addressed blobs (D9)
// before the one-batch commit; the file never enters the event log, only its blob reference.

/** An encrypted content-addressed blob reference (events.md 8.5 `archive`). */
export interface BlobRef {
  readonly sha256: string;
  readonly ext: string;
}

/**
 * Where committed imports are archived: encrypts `content` with the vault's key and stores it under
 * its plaintext sha256 (content-addressed: archiving the same file twice stores it once). Blob
 * garbage collection (S28) deletes only blobs no applied event references.
 */
export interface ImportArchive {
  put(content: Uint8Array, ext: string): Promise<BlobRef>;
}
