/**
 * What every module's blank-page steps share (`core/modules.py`: `SetupStatus`, `cli_prefix`): the
 * copyable command prefix, the language pick of a text pair and the view of one module's status.
 * The steps themselves are each module's (`<module>/setup.ts`), built from facts the store reads.
 */

import type { UiLang } from "./i18n.js";
import {
  type SetupState,
  type SetupStep,
  type SetupStepDict,
  setupState,
  setupStepDicts,
} from "./modules.js";

/** A UI text in both languages (a `*.strings.ts` entry). */
export interface TextPair {
  readonly pl: string;
  readonly en: string;
}

/** Python `tr(pl=..., en=...)` with the language passed in (domain has no ambient language). */
export function pick(lang: UiLang, text: TextPair): string {
  return text[lang];
}

/** What a module's steps are rendered with. */
export interface SetupContext {
  /** `cli_prefix`: the copyable command prefix of the profile (`cliPrefix`). */
  readonly cli: string;
  readonly lang: UiLang;
}

/** Python `shlex._find_unsafe`: anything but ASCII word characters and `@%+=:,./-`. */
const UNSAFE = /[^\w@%+=:,./-]/;

/** Python `shlex.quote`: a shell-escaped version of `s`. */
export function shlexQuote(s: string): string {
  if (s === "") return "''";
  if (!UNSAFE.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

/** Python `shlex.join`. */
export function shlexJoin(parts: readonly string[]): string {
  return parts.map(shlexQuote).join(" ");
}

/**
 * `cli_prefix`: `cashu --profile <slug>` for the copyable setup commands of a profile. `program` is
 * the runtime's CLI command (`runtime.cli_program()`: `["cashu"]`, or the packaged app's bundled
 * binary); `slug` null when the profile is gone (the program alone).
 */
export function cliPrefix(program: readonly string[], slug: string | null): string {
  return shlexJoin(slug === null ? program : [...program, "--profile", slug]);
}

/**
 * `claude_mcp_add`: the `claude mcp add` line that registers the profile's MCP server
 * (`cashu-<slug>`, running `<program> mcp --profile <slug>`) in Claude Code.
 */
export function claudeMcpAdd(program: readonly string[], slug: string): string {
  return shlexJoin([
    "claude",
    "mcp",
    "add",
    `cashu-${slug}`,
    "--",
    ...program,
    "mcp",
    "--profile",
    slug,
  ]);
}

/**
 * The `claude mcp remove` line of the profile's MCP server (`cashu-<slug>`): drops a registration of
 * the same name (the retired Python app's, which points at a binary that no longer exists).
 */
export function claudeMcpRemove(slug: string): string {
  return shlexJoin(["claude", "mcp", "remove", `cashu-${slug}`]);
}

/**
 * The lines that point Claude Code at this install's MCP servers after a Python import: per profile,
 * the old registration's `claude mcp remove`, then the setup screen's `claude mcp add`.
 */
export function reconnectMcpCommands(
  program: readonly string[],
  slugs: readonly string[],
): string[] {
  return slugs.flatMap((slug) => [claudeMcpRemove(slug), claudeMcpAdd(program, slug)]);
}

/** One module's blank-page status as the API and the MCP tool show it. */
export interface SetupView {
  readonly state: SetupState;
  readonly steps: readonly SetupStepDict[];
}

/** `SetupStatus(steps)` -> `{state, step_dicts()}`. */
export function setupView(steps: readonly SetupStep[]): SetupView {
  return { state: setupState(steps), steps: setupStepDicts(steps) };
}

/** A required step (Python `SetupStep(...)` with `optional=False`). */
export function setupStep(
  id: string,
  title: string,
  description: string,
  done: boolean,
  actions: SetupStep["actions"],
  optional = false,
): SetupStep {
  return { id, title, description, done, actions, optional };
}
