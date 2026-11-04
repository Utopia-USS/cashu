// Native shipped-skills commands. Help/parse errors and unsupported legacy markup defer before I/O.

import { realpathSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { CommandIo, PortedCommand } from "../tree.js";
import { printConsole, supportsConsoleUnicode } from "./console.js";
import {
  copyableTree,
  directoryTarget,
  expandHome,
  filesystemPath,
  isSymlink,
  pathSpelling,
  removableTree,
  restoreCopyTimes,
  sameTree,
  skillNames,
  stat,
  writableAncestor,
} from "./skillsFiles.js";

const UNHANDLED = { kind: "unhandled" } as const;
const RESTART =
  "Restart Claude Code to pick up new skills. Each skill talks to a profile's MCP server: see Settings > Agent AI in the app for the `claude mcp add` line, or create the profile's agent workspace (server, skills and permissions in one folder): `cashu workspace init --profile <slug>`.";
interface Install {
  readonly kind: "install";
  readonly dest: string;
  readonly force: boolean;
}
function parse(args: readonly string[]): Install | { readonly kind: "path" } | undefined {
  if (args[0] === "path" && (args.length === 1 || (args.length === 2 && args[1] === "--")))
    return { kind: "path" };
  if (args[0] !== "install") return undefined;
  let dest = "~/.claude/skills";
  let force = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") force = true;
    else if (arg === "--no-force") force = false;
    else if (arg?.startsWith("--dest=")) dest = arg.slice(7);
    else if (arg === "--dest") {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) return undefined;
      dest = next;
    } else if (arg === "--" && i === args.length - 1) break;
    else return undefined;
  }
  return { kind: "install", dest, force };
}
/** These need Python's general markup/emoji parser, not silent escaping by the native renderer. */
function legacyText(text: string): boolean {
  return (
    /[[\]\\]|:[\w+-]+:/u.test(text) ||
    Array.from(text).some((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point < 32 || (point >= 0x7f && point < 0xa0);
    })
  );
}
interface Action {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly shown: string;
  readonly kind: "installed" | "replaced" | "same" | "skipped";
}
function plan(
  source: string,
  dest: string,
  actualDest: string,
  force: boolean,
): Action[] | undefined {
  const actions: Action[] = [];
  for (const name of skillNames(source)) {
    const from = join(source, name);
    const shown = pathSpelling(`${dest}/${name}`);
    const target = join(actualDest, name);
    if (legacyText(name) || legacyText(shown)) return undefined;
    const relation = relative(realpathSync(from), target);
    if (relation && !relation.startsWith("../") && relation !== ".." && !relation.startsWith("/"))
      return undefined;
    const existing = stat(target);
    let kind: Action["kind"];
    if (existing === undefined) {
      // Path.exists is false for a broken link, but copytree would fail. Delegate before any output.
      if (isSymlink(target)) return undefined;
      kind = "installed";
    } else if (existing.isDirectory()) {
      const same = sameTree(from, target);
      if (same === undefined) return undefined;
      kind = same ? "same" : force && !isSymlink(target) ? "replaced" : "skipped";
    } else kind = "skipped";
    if ((kind === "installed" || kind === "replaced") && !copyableTree(from)) return undefined;
    if (kind === "installed" || kind === "replaced") writableAncestor(dirname(target));
    if (kind === "replaced") removableTree(target);
    actions.push({ name, source: from, target, shown, kind });
  }
  return actions;
}
function missingSource(io: CommandIo): number {
  const text = "No skills found in this installation.";
  printConsole(io, text, {
    stream: "stderr",
    spans: [{ start: 0, end: text.length, style: { color: 31 } }],
  });
  return 1;
}
/** Resource path is injected; undefined means this build has no packaged skills resource contract. */
export function skillsCommand(source: string | undefined): PortedCommand {
  return {
    name: "skills",
    async run(args, io) {
      const parsed = parse(args);
      if (parsed === undefined || source === undefined) return UNHANDLED;
      // TRANSITIONAL(S39a): legacy help/errors/markup and older explicit Unicode versions stay delegated.
      if (!supportsConsoleUnicode(io)) return UNHANDLED;
      try {
        if (!stat(source)?.isDirectory()) return missingSource(io);
      } catch {
        return UNHANDLED;
      }
      if (parsed.kind === "path") {
        io.stdout(`${source}\n`);
        return 0;
      }
      const spelling = pathSpelling(parsed.dest);
      if (/^~[^/]/.test(spelling)) return UNHANDLED;
      const expands = spelling === "~" || spelling.startsWith("~/");
      if (expands && io.paths === undefined) return UNHANDLED;
      const dest = expands ? expandHome(spelling, io.paths?.home ?? "") : spelling;
      if (legacyText(dest)) return UNHANDLED;
      const absolute = filesystemPath(io.cwd, dest);
      let actions: Action[] | undefined;
      try {
        const target = directoryTarget(absolute);
        if (target === undefined) return UNHANDLED;
        actions = plan(source, dest, target, parsed.force);
      } catch {
        return UNHANDLED;
      }
      if (actions === undefined) return UNHANDLED;
      if (io.signal.aborted) return 130;
      await mkdir(absolute, { recursive: true });
      let skipped = 0;
      for (const action of actions) {
        if (io.signal.aborted) return 130;
        if (action.kind === "installed" || action.kind === "replaced") {
          if (action.kind === "replaced") await rm(action.target, { recursive: true });
          await cp(action.source, action.target, {
            recursive: true,
            dereference: true,
            preserveTimestamps: true,
            force: false,
            errorOnExist: true,
          });
          restoreCopyTimes(action.source, action.target);
          const verb = action.kind;
          printConsole(
            io,
            `${verb}${verb === "installed" ? " " : "  "}/${action.name} -> ${action.shown}`,
            { spans: [{ start: 0, end: verb.length, style: { color: 32 } }] },
          );
        } else if (action.kind === "same") printConsole(io, `up to date  /${action.name}`);
        else {
          skipped += 1;
          printConsole(
            io,
            `skipped   /${action.name}: ${action.shown} exists and differs (--force replaces it)`,
            { spans: [{ start: 0, end: 7, style: { color: 33 } }] },
          );
        }
      }
      printConsole(io, RESTART);
      return skipped ? 1 : 0;
    },
  };
}
