// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// The live Python rows of every profile, read through the genesis source readers (S31a spec 4.3: the
// phase-1 inputs of shipper-computed gids and closure snapshots). One read transaction, so the rows
// are one snapshot of the live database; the sync state genesis refuses is expected here.
import { GenesisCounters } from "../genesis/report.js";
import { type GenesisFiles, readPythonSource, scopeProfiles } from "../genesis/source.js";
import type { SqlDriver } from "../sql/driver.js";
import type { CurrentRows } from "./resolve.js";

/** By Python profile id. */
export function readLiveRows(
  driver: SqlDriver,
  files: GenesisFiles,
): ReadonlyMap<number, CurrentRows> {
  return driver.transaction(() => {
    const counters = new GenesisCounters();
    const py = readPythonSource(driver, files, counters, { liveSyncState: true });
    const global = { instruments: py.invInstruments, aliases: py.invInstrumentAliases };
    return new Map(
      scopeProfiles(py, counters).map((scope) => [scope.profile.id, { scope, global }]),
    );
  });
}
