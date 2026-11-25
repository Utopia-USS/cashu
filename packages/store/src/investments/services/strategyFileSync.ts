// Strategy files follow the recorded version on every device (events.md 8.8). Each device keeps its
// own copy of the strategy files (`vaults/<id>/strategy`) and, in its private journal
// (proposalPublication.ts), the stored version its files were last brought to or recorded as (the
// base). The recorded versions are the shared truth; the files are a device's projection of them:
//
// - files equal to the current version: in sync;
// - files changed on top of the current version (base = current): a genuine local edit, recorded as
//   a new version whose `base` is the current one;
// - files still equal to an older base: behind, so the current version is written into them; a
//   device never records older file text over a newer version;
// - files changed on top of an older base (edited while behind): a conflict. The later recorded
//   version stays current; the local text becomes an owner proposal (`source: conflict`), then the
//   files follow the current version. Nothing is lost and the outcome does not depend on timing;
// - two devices recorded concurrently (neither saw the other's version): the version later in the
//   order is current (8.8). The device whose own version was superseded by one not built on it
//   (its `base` chain does not reach it) proposes its text once, then follows.
//
// File writes go through the journal's crash-safe transition; the caller holds the device's
// strategy lock (the daily lock) so a follow never overlaps an approval's publication.
import { loadStrategy, strategyDigest } from "@cashu/domain/investments/strategy";
import type { Store } from "../../materialize.js";
import type { SavedStrategyVersion } from "../commands/strategy.js";
import {
  latestStrategyVersion,
  type StrategyVersionView,
  strategyVersionBuiltOn,
  strategyVersionLink,
  strategyVersionWithSha,
} from "../queries/strategy.js";
import {
  type ManagedImage,
  managedImage,
  openStrategyJournal,
  type PrivateStrategyJournal,
  reconcileStrategyFiles,
  type StrategyFileImage,
  type StrategyJournalDeps,
  type StrategyJournalSession,
  type StrategyPublicationFiles,
} from "./proposalPublication.js";

/** The device's strategy files and private journal: what a follower needs besides the store. */
export interface StrategyFileSyncPorts {
  readonly files: StrategyPublicationFiles;
  readonly journal: PrivateStrategyJournal;
}

/** The `createProposal` input of a conflict proposal (the caller runs it through its write path). */
export interface StrategyConflictProposal {
  readonly kind: "strategy";
  readonly summary: string;
  readonly summaryParams: Readonly<Record<string, unknown>>;
  readonly reason: null;
  readonly source: "conflict";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StrategyFileSyncDeps extends StrategyJournalDeps {
  /** Record a genuine local edit (saveStrategyVersion with `base`). Absent: report `local_edit`. */
  readonly record?: (input: {
    readonly yamlText: string;
    readonly mdText: string | null;
    readonly base: string | null;
  }) => Promise<SavedStrategyVersion>;
  /** Store a conflict proposal. Absent: report `conflict` and change nothing. */
  readonly propose?: (input: StrategyConflictProposal) => Promise<void>;
}

export type StrategyFileSyncStatus =
  /** The files are the current version's (or there is nothing to sync). */
  | "in_sync"
  /** The files were behind and now hold the current version. */
  | "followed"
  /** A genuine local edit was recorded as the new current version. */
  | "recorded"
  /** A local edit on top of the current version is not recorded (no `record`). */
  | "local_edit"
  /** Text that cannot become current was proposed (or, without `propose`, found and left alone). */
  | "conflict"
  /** No strategy.yaml on top of the current version (the owner removed it): left alone. */
  | "missing";

export interface StrategyFileSyncResult {
  readonly status: StrategyFileSyncStatus;
  /** The stored version the files now are (null: none). */
  readonly version: string | null;
  /** A conflict proposal was stored. */
  readonly proposed: boolean;
}

const normalize = (text: string | null) => text?.replace(/\r\n?/gu, "\n") ?? null;
const normalized = (image: StrategyFileImage): StrategyFileImage => ({
  yaml: normalize(image.yaml),
  md: normalize(image.md),
});
const same = (a: StrategyFileImage, b: StrategyFileImage) => a.yaml === b.yaml && a.md === b.md;
const empty = (image: StrategyFileImage) => image.yaml === null && image.md === null;

/** The image is the text with digest `sha256` (Python reads with universal newlines; older TS
 * recordings kept raw line endings, so both forms count). */
function hasDigest(image: StrategyFileImage, sha256: string | null): boolean {
  if (sha256 === null || image.yaml === null) return false;
  const plain = normalized(image);
  return (
    strategyDigest(image.yaml, image.md) === sha256 ||
    strategyDigest(plain.yaml ?? "", plain.md) === sha256
  );
}

/** A conflict proposal: `text` over the current version's files (its `base_sha256`). */
export function strategyConflictProposal(
  text: StrategyFileImage & { readonly yaml: string },
  current: StrategyVersionView,
  cause: "local_edit" | "concurrent_version",
): StrategyConflictProposal {
  const result = loadStrategy(text.yaml, text.md);
  const config = result.config ?? result.partial;
  const rules = config?.rules.length ?? 0;
  const buckets = config?.allocation.buckets.length ?? 0;
  return {
    kind: "strategy",
    summary: `Strategy kept from a conflict: ${rules} rules, ${buckets} buckets`,
    summaryParams: { rules, buckets, inactive_rules: 0, conflict: cause },
    reason: null,
    source: "conflict",
    payload: {
      yaml: text.yaml,
      md: text.md,
      base_sha256: strategyDigest(current.yamlText, current.mdText),
      conflict: cause,
      issues: result.issues.map(({ severity, path, message, line, column }) => ({
        severity,
        path,
        message,
        line,
        column,
      })),
    },
  };
}

/**
 * Bring this device's strategy files in line with the recorded versions (the rules at the top).
 * Returns what it found and did; throws `StrategyPublicationError` (`unavailable`, `user_changed`,
 * `journal_invalid`, `winner_changed`) or the caller's write error.
 */
export async function syncStrategyFiles(
  deps: StrategyFileSyncDeps,
): Promise<StrategyFileSyncResult> {
  // A record or proposal refused because another version arrived meanwhile: decide again.
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncOnce(deps);
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || error.message !== "base_changed")
        throw error;
    }
  }
}

async function syncOnce(deps: StrategyFileSyncDeps): Promise<StrategyFileSyncResult> {
  const read = deps.store.read.bind(deps.store);
  const first = await deps.files.read();
  const latestAtOpen = latestStrategyVersion(read);
  const session = await openStrategyJournal(
    deps,
    first,
    inferredBase(deps.store, first, latestAtOpen),
  );
  if (session.current().pending !== null) await reconcileStrategyFiles(deps.store, session);
  const files = await session.read();
  const latest = latestStrategyVersion(read);
  const journal = session.current();
  const base = session.existed ? journal.managed.version : inferredBase(deps.store, files, latest);
  const result = (status: StrategyFileSyncStatus, version: string | null, proposed = false) => ({
    status,
    version,
    proposed,
  });
  const accept = async (image: ManagedImage) => {
    const now = session.current();
    if (
      now.pending === null &&
      same(now.managed.image, image.image) &&
      now.managed.version === image.version &&
      now.managed.approvalEid === image.approvalEid &&
      (now.managed.recorded ?? false) === (image.recorded ?? false)
    )
      return;
    await session.write({ ...now, managed: image, pending: null });
  };
  const keep = (version: string | null) =>
    journal.managed.version === version && same(journal.managed.image, files)
      ? journal.managed
      : managedImage(files, null, version);

  if (latest === undefined) {
    if (files.yaml === null) {
      await accept(keep(null));
      return result(empty(files) ? "in_sync" : "missing", null);
    }
    return recordEdit(deps, session, files, null);
  }
  if (hasDigest(files, latest.sha256)) {
    await accept(keep(latest.gid));
    return result("in_sync", latest.gid);
  }
  if (base === latest.gid) {
    if (files.yaml === null) return result("missing", latest.gid);
    return recordEdit(deps, session, files, latest.gid);
  }
  // The files are behind the current version: still the base's text, or edited on top of it.
  const baseSha = base === null ? null : (strategyVersionLink(read, base)?.sha256 ?? null);
  const unchanged =
    base === null
      ? empty(files)
      : hasDigest(files, baseSha) ||
        (baseSha === null &&
          journal.managed.version === base &&
          same(journal.managed.image, files));
  if (!unchanged) {
    if (files.yaml === null) return result("missing", base);
    if (deps.propose === undefined) return result("conflict", base);
    await proposeOnce(
      deps,
      strategyConflictProposal(
        { ...normalized(files), yaml: normalize(files.yaml) ?? "" },
        latest,
        "local_edit",
      ),
    );
    // The edit is kept in the proposal: the files may now follow the current version.
    await accept(managedImage(files, null, base));
    await follow(deps.store, session, latest);
    return result("conflict", latest.gid, true);
  }
  const authored =
    session.existed &&
    journal.managed.version === base &&
    (journal.managed.approvalEid !== null || journal.managed.recorded === true);
  if (base !== null && authored && !strategyVersionBuiltOn(read, latest.gid, base)) {
    // This device's own version was superseded by one recorded without seeing it.
    if (deps.propose === undefined) return result("conflict", base);
    const own = strategyVersionText(deps.store, base) ?? normalized(files);
    if (own.yaml !== null) {
      await proposeOnce(
        deps,
        strategyConflictProposal({ ...own, yaml: own.yaml }, latest, "concurrent_version"),
      );
      await follow(deps.store, session, latest);
      return result("conflict", latest.gid, true);
    }
  }
  await follow(deps.store, session, latest);
  return result("followed", latest.gid);
}

/**
 * Store the conflict proposal unless this device already stored the same one (a pass interrupted
 * between the proposal and the file write repeats the decision; the text must not be proposed twice).
 */
async function proposeOnce(
  deps: StrategyFileSyncDeps,
  proposal: StrategyConflictProposal,
): Promise<void> {
  const key = (payload: Readonly<Record<string, unknown>>) =>
    JSON.stringify([payload.yaml, payload.md ?? null, payload.base_sha256, payload.conflict]);
  const wanted = key(proposal.payload);
  const stored = deps.store.read<{ payload: string }>(
    "SELECT payload FROM proposals WHERE kind = 'strategy' AND source = 'conflict'",
  );
  for (const row of stored) {
    try {
      if (key(JSON.parse(row.payload) as Record<string, unknown>) === wanted) return;
    } catch {
      // An unreadable payload is not the same proposal.
    }
  }
  await deps.propose?.(proposal);
}

/** Without a journal (first run on this device): the newest version the files equal, else the
 * current one (a local edit on top of it, as before base tracking), else none. */
function inferredBase(
  store: Store,
  files: StrategyFileImage,
  latest: StrategyVersionView | undefined,
): string | null {
  if (files.yaml === null) return files.md === null ? null : (latest?.gid ?? null);
  const read = store.read.bind(store);
  const plain = normalized(files);
  return (
    strategyVersionWithSha(read, strategyDigest(files.yaml, files.md)) ??
    strategyVersionWithSha(read, strategyDigest(plain.yaml ?? "", plain.md)) ??
    latest?.gid ??
    null
  );
}

function strategyVersionText(store: Store, gid: string): StrategyFileImage | null {
  const row = store.read<{ yaml: string; md: string | null }>(
    "SELECT yaml_text AS yaml, md_text AS md FROM inv_strategy_versions WHERE gid = ?",
    gid,
  )[0];
  return row === undefined ? null : { yaml: row.yaml, md: row.md };
}

async function recordEdit(
  deps: StrategyFileSyncDeps,
  session: StrategyJournalSession,
  files: StrategyFileImage,
  base: string | null,
): Promise<StrategyFileSyncResult> {
  if (deps.record === undefined) return { status: "local_edit", version: base, proposed: false };
  const text = normalized(files);
  const saved = await deps.record({ yamlText: text.yaml ?? "", mdText: text.md, base });
  session.check();
  const now = session.current();
  await session.write({
    ...now,
    managed: managedImage(files, null, saved.version, saved.recorded),
    pending: null,
  });
  return {
    status: saved.recorded ? "recorded" : "in_sync",
    version: saved.version,
    proposed: false,
  };
}

/** Write the current version into the files (its image as reconciliation picks it). */
async function follow(
  store: Store,
  session: StrategyJournalSession,
  latest: StrategyVersionView,
): Promise<void> {
  const guard = () => {
    session.check();
    if (latestStrategyVersion(store.read.bind(store))?.gid !== latest.gid)
      throw new Error("base_changed");
  };
  guard();
  const journal = session.current();
  // Reconciliation keeps an effective approval receipt's exact bytes for this version.
  const receipt = [journal.pending?.after, journal.managed, ...journal.receipts.toReversed()].find(
    (image) => image !== undefined && image.version === latest.gid && image.approvalEid !== null,
  );
  const target =
    receipt ?? managedImage({ yaml: latest.yamlText, md: latest.mdText }, null, latest.gid);
  await session.transition(target, guard);
}
