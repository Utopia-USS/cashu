// A profile's strategy files (Python `service/strategy.py`): reading them through a port, validating
// with the domain loader, recording a version when they changed, templates. States: `missing` (no
// strategy.yaml: valuation only, no rules), `valid`, `partial` (only some rule entries have errors),
// `invalid` (the file cannot be used). The store is platform free: the files live behind
// `StrategyFilesPort`, which the desktop wires to `<data dir>/profiles/<slug>/` and tests fake.
import {
  type InactiveRule,
  type StrategyConfig,
  type StrategyIssue,
  type StrategyLoadResult,
  type StrategyStateName,
  strategyDigest,
  strategyStatus,
  usableConfig,
} from "@cashu/domain/investments/strategy";
import {
  type Command,
  type CommandEnv,
  type EventWriter,
  refuse,
  runCommand,
} from "../../command.js";
import { createProposal } from "../../core/proposal-commands.js";
import type { Store } from "../../materialize.js";
import { saveStrategyVersion } from "../commands/strategy.js";
import { ensureProxy, ensureProxyDurable } from "../performance/backfill.js";
import { latestStrategyVersion, type StrategyVersionView } from "../queries/strategy.js";
import { type DurableWrite, DurableWriteUnknown, requireDurable } from "./durable.js";
import { StrategyPublicationError } from "./proposalPublication.js";
import { type StrategyFileSyncPorts, syncStrategyFiles } from "./strategyFileSync.js";

export { MAX_STRATEGY_FILE_BYTES } from "../commands/strategy.js";

import { STRATEGY_MD, STRATEGY_YAML, type StrategyFileName } from "./strategyFileNames.js";

export { STRATEGY_MD, STRATEGY_YAML, type StrategyFileName } from "./strategyFileNames.js";

/** A failed read (Python `OSError` / `UnicodeDecodeError` / the size check), message safe to show. */
export interface StrategyReadError {
  readonly error: string;
}

/**
 * The profile's strategy files (Python `files.strategy_yaml_path` / `strategy_md_path`). The adapter
 * resolves the profile directory from a slug checked with `checkedProfileSlug`, returns a read error
 * for a file larger than `MAX_STRATEGY_FILE_BYTES` or not UTF-8, and writes owner-only (0600 file,
 * 0700 directories) and atomically (Python `files.write_text_private`).
 */
export interface StrategyFilesPort {
  /** The file's text, null when it does not exist (not a regular file), or a read error. */
  read(name: StrategyFileName): Promise<string | null | StrategyReadError>;
  write(name: StrategyFileName, text: string): Promise<void>;
  exists(name: StrategyFileName): Promise<boolean>;
}

/** Python `_SLUG`: a profile slug that is safe as one path segment. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Python `files._checked_slug` for port adapters: the slug, or null when it could escape the profile
 * directory (`../x`, `a/b`, empty, hidden).
 * PARITY(S22b): Python's `re.match(... $)` also accepts one trailing newline; this refuses it.
 */
export function checkedProfileSlug(slug: string): string | null {
  return SLUG.test(slug) ? slug : null;
}

const isReadError = (v: string | null | StrategyReadError): v is StrategyReadError =>
  typeof v === "object" && v !== null;

/** Python `read_files`: (yaml, md, error); a failed read of either file fails both. */
export async function readStrategyFiles(
  files: StrategyFilesPort,
): Promise<{ yaml: string | null; md: string | null; readError: string | null }> {
  const failed = (e: StrategyReadError) => ({
    yaml: null,
    md: null,
    readError: `cannot read the strategy files: ${e.error}`,
  });
  const yaml = await files.read(STRATEGY_YAML);
  if (isReadError(yaml)) return failed(yaml);
  const md = await files.read(STRATEGY_MD);
  if (isReadError(md)) return failed(md);
  return { yaml, md, readError: null };
}

/** Python `StrategyState`. */
export interface StrategyState {
  readonly state: StrategyStateName;
  readonly result: StrategyLoadResult | null;
  /** The usable config: the valid one, or the partial one (valid rules only). */
  readonly config: StrategyConfig | null;
  readonly issues: readonly StrategyIssue[];
  readonly inactiveRules: readonly InactiveRule[];
  /** Digest of the current files (`_digest`), null without a strategy.yaml. */
  readonly sha256: string | null;
  /** The newest stored version (the current files when `changed` is false). */
  readonly version: StrategyVersionView | null;
  /** The files differ from the newest stored version (not recorded yet). */
  readonly changed: boolean;
  readonly readError: string | null;
}

export type LoadStrategyOptions =
  | { readonly record?: false }
  | {
      readonly record: true;
      readonly writer: EventWriter;
      readonly env: CommandEnv;
      /**
       * The device's strategy files and private journal. Before reading, the files follow the
       * recorded version (strategyFileSync.ts): a genuine local edit is recorded with its base,
       * files behind a newer version receive it, and a conflicting edit becomes a proposal. A
       * device never records older file text over a newer version.
       */
      readonly sync: StrategyFileSyncPorts;
      /** Background orchestration rechecks authority after file awaits; owner loads omit this. */
      readonly beforeRecord?: () => boolean;
      /** Host's existing vault queue; only the synchronous post-file-read phase enters it. */
      readonly runWrite?: <T>(work: () => T) => Promise<T>;
      readonly durableWrite?: DurableWrite;
    };

/**
 * Python `load`: read and validate the profile's strategy files; with `record`, first bring the
 * files in line with the recorded versions (recording a genuine local edit), and register the
 * benchmark proxy as a reference instrument (Python `ensure_quietly`: a failure there never fails
 * the load).
 */
export async function loadStrategy(
  store: Store,
  files: StrategyFilesPort,
  options: LoadStrategyOptions = {},
): Promise<StrategyState> {
  if (options.record === true) {
    if (options.beforeRecord?.() === false) throw new Error("not_leader");
    const write = async <I, R>(command: Command<I, R>, input: I): Promise<R> => {
      if (options.beforeRecord?.() === false) throw new Error("not_leader");
      if (options.durableWrite) return requireDurable(options.durableWrite, command, input);
      // Authority is checked again inside the queued step, right before the append.
      const run = () =>
        options.beforeRecord?.() === false
          ? refuse("not_leader")
          : runCommand(store, options.writer, command, input, options.env);
      const out = options.runWrite ? await options.runWrite(run) : run();
      if (!out.ok) throw new Error(out.reason);
      return out.value;
    };
    try {
      await syncStrategyFiles({
        store,
        files: options.sync.files,
        journal: options.sync.journal,
        isVaultCurrent: () => true,
        record: (input) => write(saveStrategyVersion, input),
        propose: async (input) => {
          await write(createProposal, input);
        },
      });
    } catch (error) {
      // Unreadable files or an unknown edit during an interrupted write: nothing is recorded and
      // the files are validated as they are (a later run reconciles). Write failures propagate.
      if (!(error instanceof StrategyPublicationError)) throw error;
    }
  }
  const read = await readStrategyFiles(files);
  const latest = latestStrategyVersion(store.read.bind(store)) ?? null;
  const status = strategyStatus(read, latest);
  const proxy = status.result?.config?.benchmark?.proxy;
  if (options.record === true && proxy) {
    if (options.durableWrite) {
      try {
        await ensureProxyDurable(store, proxy, options.durableWrite);
      } catch (error) {
        if (error instanceof DurableWriteUnknown) throw error;
      }
    } else {
      const { writer, env } = options;
      const ensure = () => {
        if (options.beforeRecord?.() === false) throw new Error("not_leader");
        try {
          ensureProxy({ store, writer, env }, proxy);
        } catch {
          // Python logs it; the benchmark then stays proxy_not_found until a later load
        }
      };
      if (options.runWrite) await options.runWrite(ensure);
      else ensure();
    }
  }
  const version = latestStrategyVersion(store.read.bind(store)) ?? null;
  return {
    state: status.state,
    result: status.result,
    config: usableConfig(status),
    issues: status.result?.issues ?? [],
    inactiveRules: status.result?.inactiveRules ?? [],
    sha256: status.sha256,
    version,
    changed:
      status.state === "missing" || status.readError !== null
        ? false
        : !versionHasText(version, read.yaml, read.md),
    readError: status.readError,
  };
}

/** The version's text is the files' (raw, or read with universal newlines as Python does). */
function versionHasText(
  version: StrategyVersionView | null,
  yaml: string | null,
  md: string | null,
): boolean {
  if (version === null || yaml === null) return false;
  const plain = (t: string | null) => t?.replace(/\r\n?/gu, "\n") ?? null;
  return (
    version.sha256 === strategyDigest(yaml, md) ||
    version.sha256 === strategyDigest(plain(yaml) ?? "", plain(md))
  );
}
