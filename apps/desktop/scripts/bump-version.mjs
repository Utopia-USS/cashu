#!/usr/bin/env node
// Bump the desktop app version after a push to main (run by .github/workflows/bump-version.yml).
// The version lives in apps/desktop/package.json ("version"), which electron-builder stamps into the app.
//
// - the patch number by default (0.5.0 -> 0.5.1);
// - the minor or major number when a pushed commit message contains "[minor]" or "[major]";
// - nothing when the push already changed the version by hand (--since names the commit before the
//   push) or a commit message contains "[skip bump]".
//
//   node apps/desktop/scripts/bump-version.mjs --since <sha before the push>   # prints the new version or nothing
//   node apps/desktop/scripts/bump-version.mjs --dry-run                        # show what would happen
//
// Node built-ins only, so the workflow needs no install step.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MANIFEST = "apps/desktop/package.json";
const VERSION_RE = /^(\s*"version"\s*:\s*")(\d+\.\d+\.\d+)(")/m;

function readVersion(text) {
  return VERSION_RE.exec(text)?.[2] ?? null;
}

function bump(version, level) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** "major" / "minor" / "patch" from the pushed commit messages; null for "[skip bump]". */
function levelFromMessages(messages) {
  const lowered = messages.toLowerCase();
  if (lowered.includes("[skip bump]")) return null;
  if (lowered.includes("[major]")) return "major";
  if (lowered.includes("[minor]")) return "minor";
  return "patch";
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `<since>..HEAD` when `since` is a commit this clone knows; null for a new branch / first push. */
function pushedRange(since) {
  if (!since || /^0+$/.test(since)) return null;
  try {
    git("cat-file", "-e", `${since}^{commit}`);
  } catch {
    return null;
  }
  return `${since}..HEAD`;
}

const { values } = parseArgs({
  options: { since: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});
const path = `${ROOT}${MANIFEST}`;
const text = readFileSync(path, "utf8");
const current = readVersion(text);
if (current === null) {
  console.error(`error: no X.Y.Z "version" in ${MANIFEST}`);
  process.exit(1);
}

const range = pushedRange(values.since);
let messages;
if (range !== null) {
  let before = null;
  try {
    before = readVersion(git("show", `${values.since}:${MANIFEST}`));
  } catch {
    // The manifest is new in this push: its version counts as set by hand.
  }
  if (before !== current) {
    console.error(`skip: the push changed the version by hand (${before} -> ${current})`);
    process.exit(0);
  }
  messages = git("log", "--format=%B", range);
} else {
  messages = git("log", "-1", "--format=%B");
}

const level = levelFromMessages(messages);
if (level === null) {
  console.error("skip: [skip bump] in a pushed commit message");
  process.exit(0);
}
const next = bump(current, level);
if (values["dry-run"]) {
  console.error(`${current} -> ${next} (${level})`);
  process.exit(0);
}
writeFileSync(path, text.replace(VERSION_RE, `$1${next}$3`));
console.log(next);
