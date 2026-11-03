// Device-local compensating publication. These private images never enter events or diagnostics.
import { sha256Hex } from "@cashu/domain";
import { proposalExecution } from "../../core/proposal-execution.js";
import type { ApprovalPublication } from "../../core/proposal-service.js";
import type { Store } from "../../materialize.js";
import type { SavedStrategyVersion } from "../commands/strategy.js";
import { latestStrategyVersion } from "../queries/strategy.js";
import { STRATEGY_MD, STRATEGY_YAML, type StrategyFileName } from "./strategy.js";

export interface StrategyFileImage {
  readonly yaml: string | null;
  readonly md: string | null;
}
export interface StrategyFileDigests {
  readonly yaml: string | null;
  readonly md: string | null;
}

/** Real authority supplies bounded private reads, including a synchronous guarded-record recheck. */
export interface StrategyPublicationFiles {
  readonly vault: string;
  isCurrent(): boolean;
  read(): Promise<StrategyFileImage>;
  readSync(): StrategyFileImage;
  /** Opaque private 0600 temporary file, in the same owner-only directory as its closed target. */
  stage(name: StrategyFileName, text: string): Promise<object>;
  install(name: StrategyFileName, temporary: object): Promise<void>;
  remove(name: StrategyFileName): Promise<void>;
  discard(temporary: object): Promise<void>;
}

interface ManagedImage {
  readonly image: StrategyFileImage;
  readonly digests: StrategyFileDigests;
  readonly approvalEid: string | null;
  readonly version: string | null;
}
export interface StrategyPublicationJournal {
  readonly vault: string;
  /** Never replaced by the previous managed image during a later publication. */
  readonly baseline: StrategyFileImage;
  readonly baselineDigests: StrategyFileDigests;
  readonly baselineVersion: string | null;
  readonly managed: ManagedImage;
  readonly pending: { readonly before: ManagedImage; readonly after: ManagedImage } | null;
}
export interface PrivateStrategyJournal {
  readonly vault: string;
  /** Atomic private durable storage, isolated to this device and vault. */
  read(): Promise<StrategyPublicationJournal | null>;
  write(journal: StrategyPublicationJournal): Promise<void>;
}

export interface StrategyPublicationDeps {
  readonly store: Store;
  readonly proposalGid: string;
  readonly files: StrategyPublicationFiles;
  readonly journal: PrivateStrategyJournal;
  readonly isVaultCurrent: () => boolean;
}

export class StrategyPublicationError extends Error {
  readonly code:
    | "unavailable"
    | "base_changed"
    | "winner_changed"
    | "user_changed"
    | "journal_invalid";
  constructor(
    code: "unavailable" | "base_changed" | "winner_changed" | "user_changed" | "journal_invalid",
  ) {
    super(code);
    this.code = code;
    this.name = "StrategyPublicationError";
  }
}

export function strategyFileDigests(image: StrategyFileImage): StrategyFileDigests {
  return {
    yaml: image.yaml === null ? null : sha256Hex(image.yaml),
    md: image.md === null ? null : sha256Hex(image.md),
  };
}
function same(a: StrategyFileImage, b: StrategyFileImage): boolean {
  return a.yaml === b.yaml && a.md === b.md;
}
function managed(
  image: StrategyFileImage,
  approvalEid: string | null,
  version: string | null,
): ManagedImage {
  return {
    image: { yaml: image.yaml, md: image.md },
    digests: strategyFileDigests(image),
    approvalEid,
    version,
  };
}
function validImage(image: StrategyFileImage, digests: StrategyFileDigests): boolean {
  const actual = strategyFileDigests(image);
  return actual.yaml === digests.yaml && actual.md === digests.md;
}

/** Construct only for an owner approval, never during an agent's proposal/dry run. */
export async function prepareStrategyPublication(
  deps: StrategyPublicationDeps,
  base: StrategyFileImage,
  target: StrategyFileImage,
): Promise<ApprovalPublication<SavedStrategyVersion> & { isBaseCurrent(): boolean }> {
  const check = () => {
    try {
      if (
        deps.files.vault === deps.store.vault &&
        deps.journal.vault === deps.store.vault &&
        deps.isVaultCurrent() &&
        deps.files.isCurrent()
      )
        return;
    } catch {
      /* An unavailable capability never grants file access. */
    }
    throw new StrategyPublicationError("unavailable");
  };
  const read = async () => {
    check();
    const value = await deps.files.read();
    check();
    return value;
  };
  check();
  const saved = await deps.journal.read();
  check();
  if (
    saved !== null &&
    (saved.vault !== deps.store.vault ||
      !validImage(saved.baseline, saved.baselineDigests) ||
      !validImage(saved.managed.image, saved.managed.digests) ||
      (saved.pending !== null &&
        (!validImage(saved.pending.before.image, saved.pending.before.digests) ||
          !validImage(saved.pending.after.image, saved.pending.after.digests))))
  )
    throw new StrategyPublicationError("journal_invalid");
  const baselineVersion = latestStrategyVersion(deps.store.read.bind(deps.store))?.gid ?? null;
  let journal: StrategyPublicationJournal = saved ?? {
    vault: deps.store.vault,
    baseline: { yaml: base.yaml, md: base.md },
    baselineDigests: strategyFileDigests(base),
    baselineVersion,
    managed: managed(base, null, baselineVersion),
    pending: null,
  };
  const restoreTarget = managed(
    base,
    saved?.managed.approvalEid ?? null,
    saved?.managed.version ?? baselineVersion,
  );
  const writeJournal = async (next: StrategyPublicationJournal) => {
    check();
    await deps.journal.write(next);
    check();
    journal = next;
  };
  const known = (current: StrategyFileImage): boolean => {
    if (journal.pending === null) return same(current, journal.managed.image);
    const { before, after } = journal.pending;
    return (
      (current.yaml === before.image.yaml || current.yaml === after.image.yaml) &&
      (current.md === before.image.md || current.md === after.image.md)
    );
  };
  const winner = (approvalEid: string) => {
    check();
    const row = proposalExecution(deps.store.read.bind(deps.store), deps.proposalGid);
    if (row?.status !== "approved" || row.approvalEid !== approvalEid)
      throw new StrategyPublicationError("winner_changed");
  };
  const transition = async (after: ManagedImage, guard: () => void) => {
    guard();
    const before = await read();
    guard();
    if (!known(before)) throw new StrategyPublicationError("user_changed");
    // Preserve an existing mixed-rename intent before recovery; all its known states remain safe.
    const prior = managed(before, journal.managed.approvalEid, journal.managed.version);
    await writeJournal({ ...journal, pending: { before: prior, after } });
    guard();
    const temps = new Map<StrategyFileName, object>();
    let failure: unknown;
    let failed = false;
    try {
      // Prepare every replacement before touching either live file. Null is deletion, not empty.
      for (const [name, text] of [
        [STRATEGY_YAML, after.image.yaml],
        [STRATEGY_MD, after.image.md],
      ] as const) {
        if (text !== null) {
          const temporary = await deps.files.stage(name, text);
          temps.set(name, temporary);
          guard();
        }
      }
      for (const [name, key] of [
        [STRATEGY_YAML, "yaml"],
        [STRATEGY_MD, "md"],
      ] as const) {
        const current = await read();
        guard();
        if (!known(current)) throw new StrategyPublicationError("user_changed");
        if (current[key] === after.image[key]) continue;
        const temporary = temps.get(name);
        if (after.image[key] === null) await deps.files.remove(name);
        else if (temporary !== undefined) {
          await deps.files.install(name, temporary);
          temps.delete(name);
        } else throw new StrategyPublicationError("journal_invalid");
        guard();
      }
      const finished = await read();
      guard();
      if (!same(finished, after.image)) throw new StrategyPublicationError("user_changed");
      await writeJournal({ ...journal, managed: after, pending: null });
      guard();
    } catch (error) {
      failure = error;
      failed = true;
    } finally {
      for (const temporary of temps.values()) {
        try {
          await deps.files.discard(temporary);
        } catch {
          if (!failed) failure = new StrategyPublicationError("unavailable");
          failed = true;
        }
      }
    }
    if (failed) throw failure;
  };
  return {
    isBaseCurrent: () => {
      try {
        check();
        return same(deps.files.readSync(), base);
      } catch {
        return false;
      }
    },
    publish: async (approvalEid, effect) => {
      winner(approvalEid);
      const current = await read();
      winner(approvalEid);
      if (!same(current, base)) throw new StrategyPublicationError("base_changed");
      await transition(managed(target, approvalEid, effect.version), () => winner(approvalEid));
    },
    restore: async () => {
      check();
      if (journal.pending === null) return;
      await transition(restoreTarget, check);
    },
    discard: async () => {
      /* No live file or temporary is created before publish. */
    },
    reconcile: async () => {
      check();
      const version = latestStrategyVersion(deps.store.read.bind(deps.store));
      const image =
        version === undefined || version.gid === journal.baselineVersion
          ? journal.baseline
          : { yaml: version.yamlText, md: version.mdText };
      const expectedVersion = version?.gid ?? null;
      const guard = () => {
        check();
        if (
          (latestStrategyVersion(deps.store.read.bind(deps.store))?.gid ?? null) !== expectedVersion
        )
          throw new StrategyPublicationError("winner_changed");
      };
      const current = await read();
      guard();
      if (!known(current)) throw new StrategyPublicationError("user_changed");
      if (same(current, image) && journal.pending === null) return;
      await transition(managed(image, null, expectedVersion), guard);
    },
  };
}
