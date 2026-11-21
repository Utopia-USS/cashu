// Key provenance: for every data key this device holds, who gave it and for whom the sender said it
// was wrapped. The ring does not record it (crypto README: S29 must persist kid -> senderDeviceId for
// every unwrapped key), and the rotation rules need it: a key whose sender is revoked, or whose
// signed recipient list names a revoked device, must not stay active (M1).

export type KeySource =
  /** This device created the key (rotation or revocation). */
  | "own"
  /** A signed wrap (`unwrapKeys`) from a trusted device or the recovery identity. */
  | "wrap"
  /** The first pairing hop: the inviter's whole ring; recipients unknown. */
  | "pairing";

export interface KeyProvenance {
  readonly kid: string;
  readonly generation: number;
  readonly epoch: number;
  /** Device id of the sender (or `RECOVERY_SIGNER_ID`). */
  readonly sender: string;
  /** The sender's signed recipient list for this rotation; null when unknown (pairing). */
  readonly recipients: readonly string[] | null;
  readonly source: KeySource;
  /** Local clock when this device learned the key (rate limit window). */
  readonly receivedAt: number;
}

/**
 * Durable, device-local (the store keeps it next to the view; it never syncs). Synchronous: both
 * runtimes use a synchronous SQLite driver in the store process. First record of a kid wins.
 */
export interface ProvenanceStore {
  get(kid: string): KeyProvenance | undefined;
  /** Records `record` unless the kid is already known. */
  put(record: KeyProvenance): void;
  list(): readonly KeyProvenance[];
}

export class MemoryProvenanceStore implements ProvenanceStore {
  readonly #records = new Map<string, KeyProvenance>();

  get(kid: string): KeyProvenance | undefined {
    return this.#records.get(kid);
  }

  put(record: KeyProvenance): void {
    if (!this.#records.has(record.kid)) {
      this.#records.set(record.kid, {
        ...record,
        recipients: record.recipients && [...record.recipients],
      });
    }
  }

  list(): readonly KeyProvenance[] {
    return [...this.#records.values()];
  }
}
