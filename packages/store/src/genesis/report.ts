// Genesis report, start (S26 spec 9.2 `report.ts`, impl notes "C3 provides"): the counters every
// phase adds to and the run's typed error. Counters are keyed by (table, reason) only, never by a
// value, a name or a slug; vaults are reported by ordinal (impl notes, change 5). C5 completes the
// report (events by type, the final JSON shape).

/** Why a genesis run refuses its input. Every refusal exits with 65 (EX_DATAERR). */
type GenesisErrorCode = "unsupported_schema";

export class GenesisError extends Error {
  readonly code: GenesisErrorCode;
  readonly exitCode = 65;

  constructor(code: GenesisErrorCode, message: string) {
    super(message);
    this.name = "GenesisError";
    this.code = code;
  }
}

// Keys are identifiers from the code (table names, reason codes), so a value can never slip in as
// a key by accident: anything else is a bug.
const KEY_RE = /^[a-z][a-z0-9_.]*$/;

/** `{ table: { reason: count } }` with keys in sorted order (a stable JSON rendering). */
type CountTable = Readonly<Record<string, Readonly<Record<string, number>>>>;

interface GenesisCountersSnapshot {
  readonly global: CountTable;
  /** Per vault ordinal (profiles ordered by id), as a decimal string key. */
  readonly vaults: Readonly<Record<string, CountTable>>;
}

type Bucket = Map<string, Map<string, number>>;

function addTo(bucket: Bucket, table: string, reason: string, n: number): void {
  if (!KEY_RE.test(table) || !KEY_RE.test(reason)) {
    throw new Error("genesis counter keys must be code identifiers");
  }
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("genesis counter increments are counts");
  if (n === 0) return;
  let reasons = bucket.get(table);
  if (reasons === undefined) {
    reasons = new Map();
    bucket.set(table, reasons);
  }
  reasons.set(reason, (reasons.get(reason) ?? 0) + n);
}

function render(bucket: Bucket): CountTable {
  const out: Record<string, Record<string, number>> = {};
  for (const table of [...bucket.keys()].sort()) {
    const reasons = bucket.get(table) ?? new Map<string, number>();
    const row: Record<string, number> = {};
    for (const reason of [...reasons.keys()].sort()) row[reason] = reasons.get(reason) ?? 0;
    out[table] = row;
  }
  return out;
}

export class GenesisCounters {
  readonly #global: Bucket = new Map();
  readonly #vaults = new Map<number, Bucket>();

  /** Count `n` occurrences of `reason` for `table`, globally (source reading, scoping). */
  add(table: string, reason: string, n = 1): void {
    addTo(this.#global, table, reason, n);
  }

  /** Count `n` occurrences of `reason` for `table` in the vault with this ordinal. */
  addVault(ordinal: number, table: string, reason: string, n = 1): void {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0)
      throw new Error("vault ordinals are indexes");
    let bucket = this.#vaults.get(ordinal);
    if (bucket === undefined) {
      bucket = new Map();
      this.#vaults.set(ordinal, bucket);
    }
    addTo(bucket, table, reason, n);
  }

  /** The global count (or the vault's, given its ordinal); 0 when never counted. */
  get(table: string, reason: string, ordinal?: number): number {
    const bucket = ordinal === undefined ? this.#global : this.#vaults.get(ordinal);
    return bucket?.get(table)?.get(reason) ?? 0;
  }

  /** A JSON-able copy with sorted keys: counts only. */
  snapshot(): GenesisCountersSnapshot {
    const vaults: Record<string, CountTable> = {};
    for (const ordinal of [...this.#vaults.keys()].sort((a, b) => a - b)) {
      vaults[String(ordinal)] = render(this.#vaults.get(ordinal) ?? new Map());
    }
    return { global: render(this.#global), vaults };
  }
}
