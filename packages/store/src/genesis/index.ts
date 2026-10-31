// TRANSITIONAL(S49): the genesis exporter reads the Python schema (Alembic 0025-0028) and goes away
// when the Python app is retired (spec D-G15).
//
// Public API of genesis (S26 spec 9.2 `index.ts`): one Python data dir (a COPY of `cashu.db` behind a
// `SqlDriver` plus its side files) -> the genesis event log of each profile (one vault per profile).
// Phase 1 (`ids.ts`) maps every exported row to its gid; phase 2 (`order.ts`, `map/*`) maps rows to
// events through that map only; `emit.ts` validates, clocks and serializes them. Deterministic: the
// same source bytes and the same `VaultKeys` give byte-identical logs (spec 7); `now` only guards the
// clock skew. Re-exported from the package as `genesis` (`import { genesis } from "@cashu/store"`,
// then `genesis.genesis(...)`).
//
// Result per vault, by ordinal (profiles ordered by id):
// - `events`: wire envelopes (`toWire`) in (hlc, eid) order, one logical batch; apply or write them
//   in chunks of `GENESIS_CHUNK` (spec 5.4);
// - `lines`: the canonical JSON of each event, `\n` terminated (the jsonl log), `logSha256` the
//   sha256 of their UTF-8 bytes;
// - `ids`: one `{table, localId, gid}` per exported source row, `localId` in Python
//   `sync_outbox._local_id` form (seeds Python's `sync_ids`, impl notes change 3);
// - `deviceLocal`: the D-G10 sidecar (notification log, connector fetch state);
// - `slug`: in memory only, to name the vault's folder; never printed or reported.
// `report` holds counts only (never values or slugs). Refusals throw `GenesisError` (exit 65):
// an unsupported schema, a profile without `VaultKeys` (`missing_keys`), `clock_skew`,
// `recon_collision`, and under `strict` an event failing `parseEvent` / `detPartsOf`
// (`invalid_event`), an id no rule rewrites (`unmapped_id_key`) or a `bad_*` counter
// (`strict_counter`). Without `strict` those rows are skipped and counted.

import type { WireEvent } from "../events/v1/envelope.js";
import { UNIT_SEPARATOR } from "../events/v1/namespaces.js";
import type { SqlDriver } from "../sql/driver.js";
import { emitVault } from "./emit.js";
import { type GlobalInstruments, type VaultKeys, vaultIds } from "./ids.js";
import { type DeviceLocal, deviceLocalOf } from "./map/agent.js";
import type { MapContext } from "./map/context.js";
import { countExpiredWithoutExpiry } from "./map/signals.js";
import { vaultRows } from "./order.js";
import {
  buildReport,
  GenesisCounters,
  GenesisError,
  type GenesisReport,
  strictFailures,
} from "./report.js";
import { Rewriter } from "./rewrite.js";
import { type GenesisFiles, type ProfileScope, readPythonSource, scopeProfiles } from "./source.js";

export { GENESIS_CHUNK } from "./emit.js";
export type { VaultKeys } from "./ids.js";
export type { DeviceLocal } from "./map/agent.js";
export type { GenesisReport } from "./report.js";
export { GenesisError } from "./report.js";
export type { GenesisFiles } from "./source.js";

export interface GenesisSource {
  /** A read-only driver over a COPY of the Python `cashu.db`. */
  readonly driver: SqlDriver;
  /** The copy's side files (budget.json, strategy files, archives, staged proposal files). */
  readonly files: GenesisFiles;
}

export interface GenesisOptions {
  /** Fail on any row that does not map (tests and CI run strict). */
  readonly strict: boolean;
  /** The caller's clock (ms since the epoch): only the `clock_skew` guard reads it. */
  readonly now: number;
}

export interface GenesisVault {
  readonly ordinal: number;
  readonly profileId: number;
  /** Internal: names the vault's folder in memory; never printed, logged or reported. */
  readonly slug: string;
  readonly vault: string;
  /** The genesis pseudo-device (gid.md 7.1). */
  readonly device: string;
  /** The base wall W of the log (ms since the epoch). */
  readonly wall: number;
  readonly events: readonly WireEvent[];
  readonly lines: readonly string[];
  readonly logSha256: string;
  readonly ids: readonly {
    readonly table: string;
    readonly localId: string;
    readonly gid: string;
  }[];
  readonly deviceLocal: DeviceLocal;
}

export interface GenesisResult {
  /** The Alembic revision of the source. */
  readonly schema: string;
  readonly vaults: readonly GenesisVault[];
  readonly report: GenesisReport;
}

interface Run {
  readonly global: GlobalInstruments;
  readonly files: GenesisFiles;
  readonly counters: GenesisCounters;
  readonly options: GenesisOptions;
}

function exportVault(
  scope: ProfileScope,
  ordinal: number,
  keys: VaultKeys,
  run: Run,
): GenesisVault {
  const { counters, options, files } = run;
  const ids = vaultIds(scope, run.global, keys, ordinal, counters);
  const ctx: MapContext = {
    ids,
    rw: new Rewriter(ids, counters, ordinal, files),
    files,
    count: (table, reason, n = 1) => counters.addVault(ordinal, table, reason, n),
    attempt(map) {
      try {
        return map();
      } catch (e) {
        if (!options.strict && e instanceof GenesisError && e.code === "unmapped_id_key") {
          return undefined;
        }
        throw e;
      }
    },
  };
  const log = emitVault(vaultRows(scope, ctx), {
    vault: keys.vault,
    salt: keys.salt,
    det: ids.det,
    strict: options.strict,
    now: options.now,
    count: (table, reason) => ctx.count(table, reason),
  });
  countExpiredWithoutExpiry(scope.alerts, new Date(log.wall).toISOString(), ctx);
  const rowKey = (table: string, localId: string) => `${table}${UNIT_SEPARATOR}${localId}`;
  const emitted = new Set(
    log.rows.flatMap((r) => (r.localId === undefined ? [] : [rowKey(r.table, r.localId)])),
  );
  return {
    ordinal,
    profileId: scope.profile.id,
    slug: scope.profile.slug,
    vault: keys.vault,
    device: log.device,
    wall: log.wall,
    events: log.events,
    lines: log.lines,
    logSha256: log.logSha256,
    ids: ids.ids.filter((e) => emitted.has(rowKey(e.table, e.localId))),
    deviceLocal: deviceLocalOf(scope.invNotificationLog, scope.connectorBindings, ctx),
  };
}

/**
 * The genesis log of every profile of a Python data dir copy. `keys` holds the `VaultKeys` of every
 * profile by slug (gid.md 7.5: genesis never mints keys).
 */
export function genesis(
  source: GenesisSource,
  keys: ReadonlyMap<string, VaultKeys>,
  options: GenesisOptions,
): GenesisResult {
  const counters = new GenesisCounters();
  const py = readPythonSource(source.driver, source.files, counters);
  const scopes = scopeProfiles(py, counters);
  const planned = scopes.map((scope, ordinal) => {
    const k = keys.get(scope.profile.slug);
    if (k === undefined)
      throw new GenesisError("missing_keys", `no vault keys for vault ${ordinal}`);
    return { scope, keys: k };
  });
  const run: Run = {
    global: { instruments: py.invInstruments, aliases: py.invInstrumentAliases },
    files: source.files,
    counters,
    options,
  };
  const vaults = planned.map((p, ordinal) => exportVault(p.scope, ordinal, p.keys, run));
  if (options.strict) {
    const failures = strictFailures(counters);
    if (failures.length > 0) {
      throw new GenesisError("strict_counter", `strict run refused: ${failures.join(", ")}`);
    }
  }
  const types = vaults.map((v) => v.events.map((e) => e.t));
  return { schema: py.schema, vaults, report: buildReport(py.schema, types, counters) };
}
