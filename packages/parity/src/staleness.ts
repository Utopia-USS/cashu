/// <reference types="node" />
/**
 * The staleness guard of `pnpm parity`: every input of a comparison (the golden dir, the TS output
 * dir and the Python-side inputs its producers read) must come from the commit under test, the git
 * HEAD of the tree this package lives in. Every producer writes `commit` and `dirty` into its
 * `index.json` (golden.py and the bridges per dir, `pnpm parity:produce` per check with the dirs it
 * read); a dir whose index lacks the commit, or names another one, is stale and the comparison is
 * refused (`--allow-stale` overrides it, loudly). Goldens inside the repo (the committed
 * `parity/golden-demo`) are versioned with the code, so their recorded commit is never HEAD; they are
 * cross-checked instead against the shared goldens of the same dataset when those are at HEAD.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** The commit under test: git HEAD of the tested tree, and whether tracked files differ from it. */
export interface TreeState {
  readonly commit: string;
  readonly dirty: boolean;
}

/** What a producer recorded: `commit` null when the index has none. */
interface Recorded {
  readonly commit: string | null;
  readonly dirty: boolean;
}

type StaleReason = "no-head" | "no-index" | "no-commit" | "other-commit" | "committed-differs";

interface StaleInput {
  /** `golden`, `ts-out` or the producer input name (`bridge-mcp`, ...). */
  readonly role: string;
  readonly dir: string;
  /** The check whose TS output or input it is (per-check TS index entries). */
  readonly check?: string;
  readonly recorded: string | null;
  readonly reason: StaleReason;
}

export interface Staleness {
  readonly head: TreeState | null;
  readonly stale: readonly StaleInput[];
  /** Informational: dirty producers, committed goldens that could not be cross-checked. */
  readonly notes: readonly string[];
}

export interface StalenessOptions {
  readonly dataset: string;
  readonly goldenDir: string;
  readonly actualDir: string;
  /** The checks being compared (the golden index order). */
  readonly checks: readonly string[];
  readonly head: TreeState | null;
  /** The tested repo: a golden dir inside it is a committed golden set. */
  readonly repoRoot: string;
  /** The lab root: the shared goldens `<labDir>/parity/out/<dataset>` cross-check committed ones. */
  readonly labDir: string;
}

/** HEAD of the tree at `repoRoot` (dirty as golden.py counts it: tracked files only), null without git. */
export function readTreeState(repoRoot: string): TreeState | null {
  const git = (...args: string[]) =>
    spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) return null;
  const status = git("status", "--porcelain", "--untracked-files=no");
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
}

/** A JSON object file, or null when it is missing or not an object. */
export function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `commit` / `dirty` of an index object; an older `"<sha>-dirty"` commit counts as dirty. */
export function recordedState(obj: Record<string, unknown> | undefined): Recorded {
  const raw = obj?.commit;
  if (typeof raw !== "string" || raw === "" || raw === "unknown") {
    return { commit: null, dirty: obj?.dirty === true };
  }
  const legacyDirty = raw.endsWith("-dirty");
  return {
    commit: legacyDirty ? raw.slice(0, -"-dirty".length) : raw,
    dirty: obj?.dirty === true || legacyDirty,
  };
}

function checkEntries(index: Record<string, unknown> | null): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const list = index?.checks;
  if (!Array.isArray(list)) return out;
  for (const e of list as unknown[]) {
    if (e !== null && typeof e === "object" && typeof (e as { check?: unknown }).check === "string")
      out.set((e as { check: string }).check, e as Record<string, unknown>);
  }
  return out;
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function isInside(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Check every input of a comparison against the commit under test. Reads index files only. */
export function checkStaleness(opts: StalenessOptions): Staleness {
  const stale: StaleInput[] = [];
  const notes: string[] = [];
  const head = opts.head;
  const seen = new Set<string>();

  /** One producer dir (its top-level index commit), checked once per dir. */
  const checkDir = (role: string, dir: string, check?: string) => {
    const key = resolve(dir);
    if (seen.has(key)) return;
    seen.add(key);
    if (isInside(dir, opts.repoRoot)) {
      checkCommitted(role, dir);
      return;
    }
    const index = readJson(join(dir, "index.json"));
    if (index === null) {
      stale.push({ role, dir, recorded: null, reason: "no-index", ...(check ? { check } : {}) });
      return;
    }
    judge(role, dir, recordedState(index), check);
  };

  const judge = (role: string, dir: string, rec: Recorded, check?: string) => {
    const at = check === undefined ? "" : ` (${check})`;
    if (rec.commit === null) {
      stale.push({ role, dir, recorded: null, reason: "no-commit", ...(check ? { check } : {}) });
    } else if (head !== null && rec.commit !== head.commit) {
      stale.push({
        role,
        dir,
        recorded: rec.commit,
        reason: "other-commit",
        ...(check ? { check } : {}),
      });
    } else if (rec.dirty) {
      notes.push(`${role} ${dir}${at} was produced from a dirty tree at ${short(rec.commit)}`);
    }
  };

  /** A golden set committed in the repo: equal to the shared goldens at HEAD, check by check. */
  const checkCommitted = (role: string, dir: string) => {
    const shared = join(opts.labDir, "parity", "out", opts.dataset);
    const sharedIndex = readJson(join(shared, "index.json"));
    const sharedState = recordedState(sharedIndex ?? undefined);
    if (head === null || sharedIndex === null || sharedState.commit !== head.commit) {
      notes.push(
        `${role} ${dir} is committed; not cross-checked (the shared ${shared} is not at HEAD)`,
      );
      return;
    }
    const mine = checkEntries(readJson(join(dir, "index.json")));
    const theirs = checkEntries(sharedIndex);
    const wanted = role === "golden" ? opts.checks : [...mine.keys()];
    for (const check of wanted) {
      const a = mine.get(check)?.sha256;
      const b = theirs.get(check)?.sha256;
      if (a === undefined || b === undefined || a !== b) {
        stale.push({ role, dir, check, recorded: null, reason: "committed-differs" });
      }
    }
  };

  if (head === null) {
    stale.push({ role: "tested tree", dir: opts.repoRoot, recorded: null, reason: "no-head" });
  }
  checkDir("golden", opts.goldenDir);

  if (resolve(opts.actualDir) !== resolve(opts.goldenDir)) {
    const actualIndex = readJson(join(opts.actualDir, "index.json"));
    const entries = checkEntries(actualIndex);
    for (const check of opts.checks) {
      if (!fileExists(join(opts.actualDir, `${check}.json`))) continue;
      const entry = entries.get(check);
      // A TS index records the commit per check; a golden-style index once, at the top.
      const rec = recordedState((entry && "commit" in entry ? entry : actualIndex) ?? undefined);
      judge("ts-out", opts.actualDir, rec, check);
      const inputs = entry?.inputs;
      if (inputs === null || typeof inputs !== "object") continue;
      for (const [name, value] of Object.entries(inputs as Record<string, unknown>)) {
        const input = value as { dir?: unknown; commit?: unknown; dirty?: unknown };
        if (typeof input?.dir !== "string") continue;
        const inRepo = isInside(input.dir, opts.repoRoot);
        if (!inRepo) {
          // What the producer read then, and what the dir holds now: both must be HEAD.
          const then = recordedState(input as Record<string, unknown>);
          if (then.commit !== head?.commit || then.commit === null) {
            judge(name, input.dir, then, check);
            continue;
          }
        }
        checkDir(name, input.dir, check);
      }
    }
  }
  return { head, stale, notes };
}

function short(commit: string | null): string {
  return commit === null ? "none" : commit.slice(0, 7);
}

function describe(s: StaleInput): string {
  const at = s.check === undefined ? "" : ` (${s.check})`;
  switch (s.reason) {
    case "no-head":
      return `${s.role} ${s.dir}: no git HEAD, so no commit under test`;
    case "no-index":
      return `${s.role} ${s.dir}${at}: no readable index.json, so no source commit`;
    case "no-commit":
      return `${s.role} ${s.dir}${at}: index.json records no source commit`;
    case "other-commit":
      return `${s.role} ${s.dir}${at}: recorded commit ${short(s.recorded)}, not HEAD`;
    case "committed-differs":
      return `${s.role} ${s.dir}${at}: committed golden differs from the shared golden at HEAD`;
  }
}

/** The lines the CLI prints: the refusal, or the loud override banner. */
export function formatStaleness(s: Staleness, allowed: boolean): string {
  const head =
    s.head === null
      ? "unknown (no git HEAD)"
      : `${s.head.commit.slice(0, 12)}${s.head.dirty ? " (dirty tree)" : ""}`;
  const lines = s.stale.map((x) => `  - ${describe(x)}`);
  if (allowed) {
    const bar = "!".repeat(72);
    return `${[
      bar,
      `!! --allow-stale: comparing ${s.stale.length} STALE input(s) against commit ${head}`,
      "!! a pass or a fail below may be an artefact of mismatched commits",
      ...lines,
      bar,
    ].join("\n")}\n`;
  }
  return `${[
    `parity refused: ${s.stale.length} input(s) are not from the commit under test ${head}`,
    ...lines,
    "Regenerate them from this commit (README 'Staleness guard'), or pass --allow-stale to compare anyway.",
  ].join("\n")}\n`;
}
