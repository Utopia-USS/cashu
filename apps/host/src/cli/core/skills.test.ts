import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import { skillsCommand } from "./skills.js";
import { expandHome, pathSpelling, sameTree } from "./skillsFiles.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-skills-"));
  dirs.push(dir);
  const source = join(dir, "source");
  const home = join(dir, "caller-home");
  const cwd = join(dir, "cwd");
  mkdirSync(join(source, "alpha", "references"), { recursive: true });
  mkdirSync(home);
  mkdirSync(cwd);
  writeFileSync(join(source, "alpha", "SKILL.md"), "synthetic original\n");
  writeFileSync(join(source, "alpha", "references", "note.md"), "reference\n");
  mkdirSync(join(source, "invalid"));
  const output = { stdout: "", stderr: "" };
  const io: CommandIo = {
    cwd,
    paths: { home },
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (s) => {
      output.stdout += s;
    },
    stderr: (s) => {
      output.stderr += s;
    },
    prompt: async () => null,
    stdin: async function* () {},
  };
  return {
    source,
    home,
    cwd,
    dir,
    io,
    output,
    run: (args: string[], override: Partial<CommandIo> = {}) =>
      skillsCommand(source).run(args, { ...io, ...override }, {}),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("prints the shipped source, and installs into the caller home rather than host home", async () => {
  const f = fixture();
  expect(await f.run(["path"])).toBe(0);
  expect(f.output.stdout).toBe(`${f.source}\n`);
  f.output.stdout = "";
  expect(await f.run(["install"])).toBe(0);
  const target = join(f.home, ".claude", "skills", "alpha");
  expect(readFileSync(join(target, "references", "note.md"), "utf8")).toBe("reference\n");
  expect(f.output.stdout).toContain("installed /alpha -> ");
  expect(f.output.stdout).not.toContain("/invalid");
  f.output.stdout = "";
  expect(await f.run(["install"])).toBe(0);
  expect(f.output.stdout).toContain("up to date  /alpha");
});
it("preserves a local edit unless force is explicit and never replaces target symlinks", async () => {
  const f = fixture();
  const dest = join(f.cwd, "target");
  await f.run(["install", "--dest", dest]);
  writeFileSync(join(dest, "alpha", "SKILL.md"), "owner edit\n");
  expect(await f.run(["install", "--dest", dest])).toBe(1);
  expect(readFileSync(join(dest, "alpha", "SKILL.md"), "utf8")).toBe("owner edit\n");
  expect(await f.run(["install", "--dest", dest, "--force"])).toBe(0);
  expect(readFileSync(join(dest, "alpha", "SKILL.md"), "utf8")).toBe("synthetic original\n");
  rmSync(join(dest, "alpha"), { recursive: true });
  const owner = join(f.dir, "owner");
  mkdirSync(owner);
  writeFileSync(join(owner, "SKILL.md"), "protected\n");
  symlinkSync(owner, join(dest, "alpha"));
  expect(await f.run(["install", "--dest", dest, "--force"])).toBe(1);
  expect(lstatSync(join(dest, "alpha")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(owner, "SKILL.md"), "utf8")).toBe("protected\n");
});
it("follows source links, accepts identical target links and skips target files", async () => {
  const f = fixture();
  const dest = join(f.cwd, "target");
  mkdirSync(dest);
  const external = join(f.dir, "external.md");
  writeFileSync(external, "linked bytes\n");
  symlinkSync(external, join(f.source, "alpha", "linked.md"));
  expect(await f.run(["install", "--dest", dest])).toBe(0);
  expect(lstatSync(join(dest, "alpha", "linked.md")).isSymbolicLink()).toBe(false);
  const existing = join(f.dir, "existing");
  cpSync(join(dest, "alpha"), existing, { recursive: true });
  rmSync(join(dest, "alpha"), { recursive: true });
  symlinkSync(existing, join(dest, "alpha"));
  expect(await f.run(["install", "--dest", dest, "--force"])).toBe(0);
  expect(lstatSync(join(dest, "alpha")).isSymbolicLink()).toBe(true);
  rmSync(join(dest, "alpha"), { recursive: true });
  writeFileSync(join(dest, "alpha"), "file remains");
  expect(await f.run(["install", "--dest", dest, "--force"])).toBe(1);
  expect(readFileSync(join(dest, "alpha"), "utf8")).toBe("file remains");
});
it("uses caller cwd while preserving pathlib spelling in output", async () => {
  const f = fixture();
  expect(await f.run(["install", "--dest", "./target//nested/../skills/"])).toBe(0);
  expect(readFileSync(join(f.cwd, "target", "skills", "alpha", "SKILL.md"), "utf8")).toBe(
    "synthetic original\n",
  );
  expect(f.output.stdout).toContain("target/nested/../skills/alpha");
  expect(pathSpelling("//a/./b//")).toBe("//a/b");
  expect(expandHome("./~/a", "/caller/home/")).toBe("/caller/home/a");
  expect(expandHome("~/a", "")).toBe("/a");
});
it("treats __pycache__ and type clashes as the same tree but never hides a changed file", () => {
  const f = fixture();
  const other = join(f.dir, "other");
  cpSync(join(f.source, "alpha"), other, { recursive: true });
  mkdirSync(join(other, "__pycache__"));
  writeFileSync(join(other, "__pycache__", "local.pyc"), "ignored");
  expect(sameTree(join(f.source, "alpha"), other)).toBe(true);
  rmSync(join(other, "SKILL.md"));
  mkdirSync(join(other, "SKILL.md"));
  expect(sameTree(join(f.source, "alpha"), other)).toBe(true);
  writeFileSync(join(other, "references", "note.md"), "different\n");
  expect(sameTree(join(f.source, "alpha"), other)).toBe(false);
});
it("answers usage errors and unsupported destinations natively before output or mutation", async () => {
  const f = fixture();
  const usage = "Usage: cashu skills path | cashu skills install [--dest DIR] [--force]\n";
  for (const args of [
    [],
    ["--help"],
    ["path", "extra"],
    ["install", "--help"],
    ["install", "--dest"],
  ]) {
    f.output.stdout = "";
    f.output.stderr = "";
    expect(await f.run(args)).toBe(2);
    expect(f.output).toEqual({ stdout: "", stderr: usage });
  }
  const refusals: [string[], Partial<CommandIo>, number, string][] = [
    [
      ["install", "--dest", "~another/skills"],
      {},
      2,
      "--dest expands only ~ and ~/. Give another user's folder as a full path.\n",
    ],
    [
      ["install"],
      { paths: undefined },
      1,
      "Your home folder is unknown. Give --dest as a full path.\n",
    ],
    [
      ["install", "--dest", "bad\u0007dir"],
      {},
      2,
      "The --dest path or a skill name contains control characters.\n",
    ],
    [
      ["install", "--dest", join(f.source, "alpha", "nested")],
      {},
      2,
      "The destination is inside this installation's skills.\n",
    ],
  ];
  for (const [args, override, code, stderr] of refusals) {
    f.output.stdout = "";
    f.output.stderr = "";
    expect(await f.run(args, override)).toBe(code);
    expect(f.output).toEqual({ stdout: "", stderr });
  }
  expect(lstatSync(join(f.home, ".claude"), { throwIfNoEntry: false })).toBeUndefined();
  expect(lstatSync(join(f.source, "alpha", "nested"), { throwIfNoEntry: false })).toBeUndefined();
  writeFileSync(join(f.cwd, "file"), "not a folder");
  f.output.stderr = "";
  expect(await f.run(["install", "--dest", "file/skills"])).toBe(1);
  expect(f.output.stderr).toBe("file/skills is not a folder.\n");
  f.output.stderr = "";
  expect(await f.run(["install", "--dest", "explicit"], { paths: undefined })).toBe(0);
});
it("prints markup-like destinations literally", async () => {
  const f = fixture();
  expect(await f.run(["install", "--dest", "[bold]path"])).toBe(0);
  expect(readFileSync(join(f.cwd, "[bold]path", "alpha", "SKILL.md"), "utf8")).toBe(
    "synthetic original\n",
  );
  expect(f.output.stdout).toContain("[bold]path/alpha");
});
it("reports a build without shipped skills as a missing source", async () => {
  const f = fixture();
  expect(await skillsCommand(undefined).run(["path"], f.io, {})).toBe(1);
  expect(f.output).toEqual({ stdout: "", stderr: "No skills found in this installation.\n" });
});
it("reports a missing source and leaves the destination untouched", async () => {
  const f = fixture();
  rmSync(f.source, { recursive: true });
  expect(await f.run(["path"])).toBe(1);
  expect(f.output).toEqual({ stdout: "", stderr: "No skills found in this installation.\n" });
});

it("resolves symlink/.. against the filesystem and keeps the requested spelling", async () => {
  const f = fixture();
  const parent = join(f.dir, "linked-parent");
  mkdirSync(join(parent, "child"), { recursive: true });
  symlinkSync(join(parent, "child"), join(f.cwd, "link"));
  expect(await f.run(["install", "--dest", "link/../skills"])).toBe(0);
  expect(readFileSync(join(parent, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
    "synthetic original\n",
  );
  expect(f.output.stdout).toContain("link/../skills/alpha");
});

it.skipIf(process.getuid?.() === 0)(
  "refuses predictable permission failures before output or filesystem writes",
  async () => {
    const f = fixture();
    const blocked = join(f.cwd, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o555);
    try {
      expect(await f.run(["install", "--dest", `${blocked}/new`])).toBe(1);
      expect(f.output).toEqual({
        stdout: "",
        stderr: `No permission to write to ${blocked}/new. Nothing was copied.\n`,
      });
      expect(lstatSync(join(blocked, "new"), { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      chmodSync(blocked, 0o755);
    }
    f.output.stderr = "";
    const unreadable = join(f.source, "alpha", "references", "note.md");
    chmodSync(unreadable, 0o000);
    try {
      expect(await f.run(["install", "--dest", "target"])).toBe(1);
      expect(f.output).toEqual({
        stdout: "",
        stderr: "The skills shipped with this installation cannot be read.\n",
      });
      expect(lstatSync(join(f.cwd, "target"), { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      chmodSync(unreadable, 0o644);
    }
  },
);
