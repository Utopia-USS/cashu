// A profile's strategy files (Python `service/strategy.py`): reading them through a port, validating
// with the domain loader, recording a version when they changed, templates. States: `missing` (no
// strategy.yaml: valuation only, no rules), `valid`, `partial` (only some rule entries have errors),
// `invalid` (the file cannot be used). The store is platform free: the files live behind
// `StrategyFilesPort`, which the desktop wires to `<data dir>/profiles/<slug>/` and tests fake.
import {
  type InactiveRule,
  STRATEGY_TEMPLATE_NAMES,
  type StrategyConfig,
  type StrategyIssue,
  type StrategyLoadResult,
  type StrategyStateName,
  strategyStatus,
  strategyTemplate,
  usableConfig,
} from "@cashu/domain/investments/strategy";
import { type CommandEnv, type EventWriter, runCommand } from "../../command.js";
import type { Store } from "../../materialize.js";
import { saveStrategyVersion } from "../commands/strategy.js";
import { ensureProxy } from "../performance/backfill.js";
import { latestStrategyVersion, type StrategyVersionView } from "../queries/strategy.js";

export { MAX_STRATEGY_FILE_BYTES } from "../commands/strategy.js";

export const STRATEGY_YAML = "strategy.yaml";
export const STRATEGY_MD = "strategy.md";
export type StrategyFileName = typeof STRATEGY_YAML | typeof STRATEGY_MD;

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
      /** Background orchestration rechecks authority after file awaits; owner loads omit this. */
      readonly beforeRecord?: () => boolean;
      /** Host's existing vault queue; only the synchronous post-file-read phase enters it. */
      readonly runWrite?: <T>(work: () => T) => Promise<T>;
    };

/**
 * Python `load`: read and validate the profile's strategy files; with `record`, store a new version
 * when they changed since the newest stored one, and register the benchmark proxy as a reference
 * instrument (Python `ensure_quietly`: a failure there never fails the load).
 */
export async function loadStrategy(
  store: Store,
  files: StrategyFilesPort,
  options: LoadStrategyOptions = {},
): Promise<StrategyState> {
  const read = await readStrategyFiles(files);
  const finish = () => {
    let latest = latestStrategyVersion(store.read.bind(store)) ?? null;
    const status = strategyStatus(read, latest);
    let changed = status.changed;
    const result = status.result;
    if (options.record === true && options.beforeRecord?.() === false)
      throw new Error("not_leader");
    if (options.record === true && read.yaml !== null && read.readError === null && changed) {
      const out = runCommand(
        store,
        options.writer,
        saveStrategyVersion,
        { yamlText: read.yaml, mdText: read.md },
        options.env,
      );
      if (!out.ok) throw new Error(`could not record the strategy version: ${out.reason}`);
      latest = latestStrategyVersion(store.read.bind(store)) ?? null;
      changed = latest?.sha256 !== status.sha256;
    }
    const proxy = result?.config?.benchmark?.proxy;
    if (options.record === true && proxy) {
      try {
        ensureProxy({ store, writer: options.writer, env: options.env }, proxy);
      } catch {
        // Python logs it; the benchmark then stays proxy_not_found until a later load
      }
    }
    return {
      state: status.state,
      result,
      config: usableConfig(status),
      issues: result?.issues ?? [],
      inactiveRules: result?.inactiveRules ?? [],
      sha256: status.sha256,
      version: latest,
      changed: status.state === "missing" || status.readError !== null ? false : changed,
      readError: status.readError,
    };
  };
  return options.record === true && options.runWrite ? options.runWrite(finish) : finish();
}

export type InitStrategyResult =
  | { readonly ok: true; readonly written: readonly StrategyFileName[] }
  | { readonly ok: false; readonly reason: "unknown_template" }
  | { readonly ok: false; readonly reason: "files_exist"; readonly existing: StrategyFileName[] };

/**
 * Python `init_files`: write strategy.yaml / strategy.md from a shipped template; refuses to overwrite
 * existing files unless `force`. Template names: `STRATEGY_TEMPLATE_NAMES`.
 */
export async function initStrategyFiles(
  files: StrategyFilesPort,
  template: string = STRATEGY_TEMPLATE_NAMES[0],
  options: { force?: boolean } = {},
): Promise<InitStrategyResult> {
  const tpl = strategyTemplate(template);
  if (tpl === null) return { ok: false, reason: "unknown_template" };
  const targets: [StrategyFileName, string][] = [
    [STRATEGY_YAML, tpl.yaml],
    [STRATEGY_MD, tpl.markdown],
  ];
  const existing: StrategyFileName[] = [];
  for (const [name] of targets) if (await files.exists(name)) existing.push(name);
  if (existing.length > 0 && options.force !== true) {
    return { ok: false, reason: "files_exist", existing };
  }
  for (const [name, text] of targets) await files.write(name, text);
  return { ok: true, written: targets.map(([name]) => name) };
}
