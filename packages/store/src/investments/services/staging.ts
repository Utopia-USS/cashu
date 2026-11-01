// Pruning of the export copies kept only until an import is decided (Python `service/staging.py`,
// F5 R9). Broker exports carry account numbers and names, so copies the app no longer needs do not
// stay on the device:
// - `staging`: uploads kept between the preview and the commit (the commit removes its file). An
//   upload older than STAGING_MAX_AGE_MS was abandoned.
// - `proposals`: the export of an import proposal (an agent's, or a fetch connector's document, also
//   `budget_import`), kept while a pending proposal references it (`payload.blob`, events.md 8.10); any
//   other file older than PROPOSAL_GRACE_MS is removed (the grace covers a proposal being stored right
//   now: its file is written before its event is applied).
// Committed imports are archived as encrypted blobs elsewhere (D9) and never touched here. `prune`
// never throws: a problem with one file is counted and the next run tries again.
import type { Read } from "../queries/shared.js";

export const STAGING_MAX_AGE_MS = 24 * 3600 * 1000;
export const PROPOSAL_GRACE_MS = 3600 * 1000;

/** The two device-local holding areas (Python `<data dir>/imports/<slug>/.staging|.proposals`). */
export type StagingFolder = "staging" | "proposals";

/** One entry of a holding area as `lstat` sees it (a symlink is never followed). */
export interface StagedEntry {
  readonly folder: StagingFolder;
  /** The file name, `<sha256>.<ext>` for the app's own files. */
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink";
  /** Last modification, ms since the epoch. */
  readonly modifiedMs: number;
}

/** The device's holding areas (the platform adapter; one listing over every profile's folders). */
export interface StagingArea {
  list(): readonly StagedEntry[];
  remove(entry: StagedEntry): void;
}

export interface PruneReport {
  readonly removed: number;
  readonly kept: number;
  readonly errors: number;
}

/**
 * The staged files pending import proposals of one vault reference (`<sha256>.<ext>` of their
 * `payload.blob`). An `applying` proposal is still pending in the view (a device-local lock state).
 */
export function referencedStagedFiles(read: Read): Set<string> {
  const out = new Set<string>();
  for (const r of read<{ payload: string }>(
    "SELECT payload FROM proposals WHERE kind IN ('import', 'budget_import') AND status = 'pending'",
  )) {
    const blob = (JSON.parse(r.payload) as { blob?: { sha256?: unknown; ext?: unknown } }).blob;
    if (typeof blob?.sha256 === "string" && typeof blob.ext === "string") {
      out.add(`${blob.sha256}.${blob.ext}`);
    }
  }
  return out;
}

/**
 * `prune`: remove abandoned uploads and unreferenced proposal exports. `referenced` is the union of
 * `referencedStagedFiles` over every vault of the device, or null when it could not be read (then
 * every proposal export is kept; uploads depend only on their age).
 */
export function prune(
  area: StagingArea,
  referenced: ReadonlySet<string> | null,
  nowMs: number,
): PruneReport {
  let removed = 0;
  let kept = 0;
  let errors = 0;
  let entries: readonly StagedEntry[];
  try {
    entries = [...area.list()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return { removed, kept, errors: 1 };
  }
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    try {
      const proposals = entry.folder === "proposals";
      if (proposals && (referenced === null || referenced.has(entry.name))) {
        kept += 1;
        continue;
      }
      const maxAge = proposals ? PROPOSAL_GRACE_MS : STAGING_MAX_AGE_MS;
      if (nowMs - entry.modifiedMs < maxAge) {
        kept += 1;
        continue;
      }
      area.remove(entry);
      removed += 1;
    } catch {
      errors += 1;
    }
  }
  return { removed, kept, errors };
}

/**
 * `prune_quietly` for startup and the worker: the references read from every vault (`vaults` yields
 * each vault's `Read`); a failing read keeps every proposal export. Never throws.
 */
export function pruneQuietly(
  area: StagingArea,
  vaults: () => Iterable<Read>,
  nowMs: number,
): PruneReport {
  let referenced: Set<string> | null = new Set();
  try {
    for (const read of vaults())
      for (const name of referencedStagedFiles(read)) referenced.add(name);
  } catch {
    referenced = null;
  }
  return prune(area, referenced, nowMs);
}
