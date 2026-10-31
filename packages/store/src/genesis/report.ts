// Genesis report (S26 spec 9.2 `report.ts`): the counters every phase adds to, the run's typed error
// and the report of a run (events by type per vault, counters, the gid.md 7.6 dangling references
// grouped per reference, the side-file counters). Counters are keyed by (table, reason) only, never
// by a value, a name or a slug; vaults are reported by ordinal (impl notes, change 5).

/**
 * Why a genesis run refuses its input. Every refusal exits with 65 (EX_DATAERR). Phase 1 (C4):
 * `recon_collision` (6.3), `gid_collision` (two rows of one table with one gid, D-G4), `unmapped_id_key` (6.5 guard), `clock_skew` (gid.md 7.1). Phase 2 (C5):
 * `missing_keys` (a profile without `VaultKeys`), `invalid_event` (an event fails `parseEvent` or the
 * `detPartsOf` self-check, under `strict`), `strict_counter` (a `bad_*` counter under `strict`).
 * Source: `sync_state_present` (the database already holds sync_ids / sync_vaults / unacked outbox
 * rows, S26 review F3).
 */
type GenesisErrorCode =
  | "unsupported_schema"
  | "recon_collision"
  | "unmapped_id_key"
  | "clock_skew"
  | "missing_keys"
  | "invalid_event"
  | "strict_counter"
  | "sync_state_present"
  | "gid_collision";

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

/** Reasons of the side files (spec 4.3, 4.4 archive, 4.8 D-G7, 6.5 staged): the report's `files`. */
const FILE_REASONS: ReadonlySet<string> = new Set([
  "budget_json_invalid",
  "strategy_files_differ",
  "strategy_same_sha",
  "archive_missing",
  "archive_hash_mismatch",
  "archive_invalid",
  "staged_missing",
  "staged_hash_mismatch",
  "staged_invalid",
]);

/** gid.md 7.6: every dangling reference is a named counter (`unscoped`, `dangling_*`). */
const isDangling = (reason: string) => reason === "unscoped" || reason.startsWith("dangling_");

/** The `table.reason` pairs of `counts` whose reason passes `keep`, sorted. */
function pick(counts: CountTable, keep: (reason: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, reasons] of Object.entries(counts)) {
    for (const [reason, n] of Object.entries(reasons))
      if (keep(reason)) out[`${table}.${reason}`] = n;
  }
  return out;
}

/** One vault of the report: by ordinal (profiles ordered by id), never by slug. */
interface GenesisVaultReport {
  readonly ordinal: number;
  readonly events: number;
  /** Events by type, sorted by type. */
  readonly byType: Readonly<Record<string, number>>;
  /** gid.md 7.6 dangling references as `table.reason` (`dangling_required`, `dangling_<column>`, ...). */
  readonly fk: Readonly<Record<string, number>>;
  /** budget.json, strategy files, archives and staged files as `table.reason`. */
  readonly files: Readonly<Record<string, number>>;
}

/** The report of a run: counts only, never values, names or slugs. */
export interface GenesisReport {
  readonly schema: string;
  readonly vaults: readonly GenesisVaultReport[];
  /** Rows no profile owns and other source-level counts (`table.reason`). */
  readonly fk: Readonly<Record<string, number>>;
  readonly counters: GenesisCountersSnapshot;
}

/** Builds the report from the event types per vault (in log order) and the run's counters. */
export function buildReport(
  schema: string,
  types: readonly (readonly string[])[],
  counters: GenesisCounters,
): GenesisReport {
  const snapshot = counters.snapshot();
  const vaults = types.map((list, ordinal) => {
    const byType: Record<string, number> = {};
    for (const t of [...list].sort()) byType[t] = (byType[t] ?? 0) + 1;
    const own = snapshot.vaults[String(ordinal)] ?? {};
    return {
      ordinal,
      events: list.length,
      byType,
      fk: pick(own, isDangling),
      files: pick(own, (r) => FILE_REASONS.has(r)),
    };
  });
  return { schema, vaults, fk: pick(snapshot.global, isDangling), counters: snapshot };
}

/** Non-`bad_*` reasons that fail a strict run: a value genesis copies but cannot trust. */
const STRICT_REASONS: ReadonlySet<string> = new Set([
  // A research note's candidate key holding a local instrument id (S26 review F6).
  "candidate_key_local_id",
]);

/**
 * `strict`: the counters that fail the run, as `table.reason`: every `bad_*` counter (rows that do
 * not decode or map) and the reasons of `STRICT_REASONS`.
 */
export function strictFailures(counters: GenesisCounters): readonly string[] {
  const snapshot = counters.snapshot();
  const bad = (r: string) => r.startsWith("bad_") || STRICT_REASONS.has(r);
  return [
    ...Object.keys(pick(snapshot.global, bad)),
    ...Object.values(snapshot.vaults).flatMap((v) => Object.keys(pick(v, bad))),
  ];
}
