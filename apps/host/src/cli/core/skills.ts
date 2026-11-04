// Native shipped-skills commands (`cashu skills path|install`). Every refusal is decided before the
// first write: a run either installs as planned or changes nothing.

import { realpathSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { CommandIo, PortedCommand } from "../tree.js";
import { printConsole } from "./console.js";
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
import { C } from "./strings.js";

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
/** Control characters would reach the terminal raw; markup-like text such as `[bold]` prints as is. */
function controlText(text: string): boolean {
  return Array.from(text).some((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point < 32 || (point >= 0x7f && point < 0xa0);
  });
}
/** A run that must not start; `code` is the exit code (2: the arguments, 1: the filesystem). */
class Refusal extends Error {
  readonly code: 1 | 2;
  constructor(text: string, code: 1 | 2) {
    super(text);
    this.code = code;
  }
}
function permissionDenied(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS")
  );
}
/** Source reads: any failure means the shipped skills cannot be used. */
function fromSource<T>(io: CommandIo, read: () => T): T {
  try {
    return read();
  } catch {
    throw new Refusal(io.t.tr(C.skillsUnreadable), 1);
  }
}
/** Destination checks: a permission failure is a refusal; anything else is unexpected. */
function atDestination<T>(io: CommandIo, shown: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (permissionDenied(error)) throw new Refusal(io.t.tr(C.skillsNotWritable)(shown), 1);
    throw error;
  }
}
interface Action {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly shown: string;
  readonly kind: "installed" | "replaced" | "same" | "skipped";
}
function plan(
  io: CommandIo,
  source: string,
  dest: string,
  actualDest: string,
  force: boolean,
): Action[] {
  const actions: Action[] = [];
  const shownDest = pathSpelling(dest);
  for (const name of fromSource(io, () => skillNames(source))) {
    const from = join(source, name);
    const shown = pathSpelling(`${dest}/${name}`);
    const target = join(actualDest, name);
    if (controlText(name)) throw new Refusal(io.t.tr(C.skillsControlText), 2);
    const relation = relative(
      fromSource(io, () => realpathSync(from)),
      target,
    );
    if (relation && !relation.startsWith("../") && relation !== ".." && !relation.startsWith("/"))
      throw new Refusal(io.t.tr(C.skillsInsideSource), 2);
    const existing = atDestination(io, shownDest, () => stat(target));
    let kind: Action["kind"];
    if (existing === undefined)
      // A broken link: never followed or replaced, like any link at the destination.
      kind = atDestination(io, shownDest, () => isSymlink(target)) ? "skipped" : "installed";
    else if (existing.isDirectory()) {
      // An unreadable or cyclic target cannot be compared: it is left alone.
      let same: boolean | undefined;
      try {
        same = sameTree(from, target);
      } catch {
        same = undefined;
      }
      kind =
        same === undefined
          ? "skipped"
          : same
            ? "same"
            : force && !isSymlink(target)
              ? "replaced"
              : "skipped";
    } else kind = "skipped";
    if (kind === "installed" || kind === "replaced") {
      if (!fromSource(io, () => copyableTree(from)))
        throw new Refusal(io.t.tr(C.skillsUnreadable), 1);
      atDestination(io, shownDest, () => writableAncestor(dirname(target)));
    }
    if (kind === "replaced") atDestination(io, shownDest, () => removableTree(target));
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
/** Resource path is injected; undefined means this build ships no skills. */
export function skillsCommand(source: string | undefined): PortedCommand {
  return {
    name: "skills",
    async run(args, io) {
      const parsed = parse(args);
      if (parsed === undefined) {
        io.stderr(`${io.t.tr(C.skillsUsage)}\n`);
        return 2;
      }
      if (source === undefined) return missingSource(io);
      let actions: Action[];
      let absolute: string;
      try {
        const present = fromSource(io, () => stat(source));
        if (!present?.isDirectory()) return missingSource(io);
        if (parsed.kind === "path") {
          io.stdout(`${source}\n`);
          return 0;
        }
        const spelling = pathSpelling(parsed.dest);
        if (/^~[^/]/.test(spelling)) throw new Refusal(io.t.tr(C.skillsUserHome), 2);
        const expands = spelling === "~" || spelling.startsWith("~/");
        if (expands && io.paths === undefined) throw new Refusal(io.t.tr(C.skillsNoHome), 1);
        const dest = expands ? expandHome(spelling, io.paths?.home ?? "") : spelling;
        if (controlText(dest)) throw new Refusal(io.t.tr(C.skillsControlText), 2);
        absolute = filesystemPath(io.cwd, dest);
        const target = atDestination(io, pathSpelling(dest), () => directoryTarget(absolute));
        if (target === undefined)
          throw new Refusal(io.t.tr(C.skillsNotDirectory)(pathSpelling(dest)), 1);
        actions = plan(io, source, dest, target, parsed.force);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        io.stderr(`${error.message}\n`);
        return error.code;
      }
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
