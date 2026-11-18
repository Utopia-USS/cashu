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
 * A PowerShell argument: bare when it holds only characters PowerShell passes through as they are,
 * else in double quotes with the characters special inside them backtick-escaped (`` ` ``, `$`, `"`
 * and the typographic double quotes PowerShell also ends a string at). A bare `--` is quoted too:
 * PowerShell reads it as its own end-of-parameters token, and Windows PowerShell drops it before a
 * native command sees it.
 */
export function powershellQuote(s: string): string {
  if (s !== "--" && /^(?:--?|\/)?[A-Za-z0-9_][A-Za-z0-9_./\\=+-]*$/.test(s)) return s;
  return `"${s.replace(/[`$"\u201C\u201D\u201E]/g, "`$&")}"`;
}

/** Characters cmd.exe interprets on a `cmd /c` command line, quoted or not (see `claudeMcpAdd`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CMD_SPECIAL = /[&<>()@^|%!"\u0000-\u001f]/;

/**
 * Whether cmd.exe reads `word` as it is on a `cmd /c` command line: false when it holds a character
 * cmd.exe interprets even inside double quotes (see `claudeMcpAdd`).
 */
export function cmdLineSafe(word: string): boolean {
  return !CMD_SPECIAL.test(word);
}

/**
 * `program` and `args` as one command line for the shell a user pastes a copied command into:
 * POSIX sh (`shlexJoin`) on macOS and Linux; PowerShell on Windows (`platform` "win32"), where a
 * program path needs the call operator (`& "C:\...\cashu.cmd" --profile jan`), since a quoted string
 * alone is only printed.
 */
export function shellCommandLine(words: readonly string[], platform?: string): string {
  if (platform !== "win32") return shlexJoin(words);
  const [program = "", ...args] = words.map(powershellQuote);
  return [program.startsWith('"') ? `& ${program}` : program, ...args].join(" ");
}

/**
 * `cli_prefix`: `cashu --profile <slug>` for the copyable setup commands of a profile. `program` is
 * the runtime's CLI command (`runtime.cli_program()`: `["cashu"]`, or the packaged app's bundled
 * binary); `slug` null when the profile is gone (the program alone). `platform` (`process.platform`
 * of the app, absent on macOS and Linux) picks the shell syntax (`shellCommandLine`).
 */
export function cliPrefix(
  program: readonly string[],
  slug: string | null,
  platform?: string,
): string {
  return shellCommandLine(slug === null ? program : [...program, "--profile", slug], platform);
}

/**
 * The `claude mcp add` line from words already written for the platform's shell: `name` the server
 * name, `server` the command line that starts the server. The one place that knows how Claude Code
 * must start a cashU MCP server on each platform: directly on macOS and Linux; on Windows through
 * `cmd /d /c` (see `claudeMcpAdd`), with the `--` quoted for PowerShell (`powershellQuote`). Every
 * word of `server` must pass `cmdLineSafe` there once the shell has expanded it.
 */
export function claudeMcpAddLine(name: string, server: string, platform?: string): string {
  return platform === "win32"
    ? `claude mcp add ${name} ${powershellQuote("--")} cmd /d /c ${server}`
    : `claude mcp add ${name} -- ${server}`;
}

/**
 * `claude_mcp_add`: the `claude mcp add` line that registers the profile's MCP server
 * (`<serverPrefix>-<slug>`, running `<program> mcp --profile <slug>`) in Claude Code. The prefix is
 * the app flavor's (`cashu`, `cashu-staging`), so two installs on one Mac never share a server name.
 *
 * Windows (`platform` "win32"): the line is PowerShell, and the program is the stable launcher, a
 * `.cmd` script. Claude Code starts a stdio server without a shell, and Node refuses to start a batch
 * file that way (EINVAL), so the server runs as `cmd /d /c "<launcher>" mcp --profile <slug>` (the
 * form Claude Code documents for Windows; `/d` skips the user's AutoRun commands, whose output would
 * corrupt the MCP stream). cmd.exe keeps the quotes around the launcher only when the line holds
 * none of its special characters, so a launcher path with one has no safe form: null.
 */
export function claudeMcpAdd(
  program: readonly string[],
  slug: string,
  serverPrefix: string,
  platform?: string,
): string | null {
  const server = [...program, "mcp", "--profile", slug];
  const name = `${serverPrefix}-${slug}`;
  if (platform === "win32") {
    if (!server.every(cmdLineSafe)) return null;
    return claudeMcpAddLine(powershellQuote(name), server.map(powershellQuote).join(" "), platform);
  }
  return claudeMcpAddLine(shlexQuote(name), shlexJoin(server));
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
