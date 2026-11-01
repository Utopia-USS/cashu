// Byte/exit-code parity against real Python, on synthetic skills and destinations only.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import { skillsCommand } from "./skills.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = join(REPO, ".venv", "bin", "python");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tree(root: string): unknown {
  if (!existsSync(root)) return null;
  return readdirSync(root)
    .sort()
    .map((name): unknown => {
      const path = join(root, name);
      const info = statSync(path);
      return [name, info.mode & 0o777, info.isDirectory() ? tree(path) : readFileSync(path, "hex")];
    });
}
function copiedTimes(root: string): unknown {
  return readdirSync(root)
    .sort()
    .map((name): unknown => {
      const path = join(root, name);
      const info = statSync(path);
      return [name, info.mtimeMs, info.isDirectory() ? copiedTimes(path) : null];
    });
}
function fixedTimes(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) fixedTimes(path);
    utimesSync(path, 1580702706, 1580702706);
  }
}
it.skipIf(!existsSync(PYTHON))(
  "matches Python path/install outputs, colors, widths, edits and force file trees",
  async () => {
    const base = mkdtempSync(join(tmpdir(), "cashu-skills-parity-"));
    dirs.push(base);
    const source = join(base, "source");
    const cwd = join(base, "cwd");
    const home = join(base, "home");
    mkdirSync(cwd);
    mkdirSync(home);
    mkdirSync(join(source, "alpha", "references"), { recursive: true });
    mkdirSync(join(source, "表🙂"));
    writeFileSync(join(source, "alpha", "SKILL.md"), "synthetic skill\n", { mode: 0o640 });
    writeFileSync(join(source, "alpha", "references", "guide.md"), "synthetic reference\n");
    writeFileSync(join(source, "表🙂", "SKILL.md"), "synthetic Unicode name\n");
    fixedTimes(source);
    const safeEnv = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      CASHU_TESTING: "1",
      CASHU_DATA_DIR: join(base, "data"),
      PYTHONPATH: join(REPO, "src"),
      CASHU_LANG: "en",
      LANG: "en_US.UTF-8",
    };
    const edited = join(home, ".claude", "skills", "alpha", "SKILL.md");
    const runs: { args: string[]; env: Record<string, string>; edit?: string }[] = [
      { args: ["path"], env: {} },
      { args: ["install"], env: {} },
      { args: ["install"], env: { FORCE_COLOR: "1", COLUMNS: "43" } },
      { args: ["install"], env: { FORCE_COLOR: "1", COLUMNS: "43" }, edit: edited },
      { args: ["install", "--force"], env: { FORCE_COLOR: "1", COLUMNS: "47" } },
      { args: ["install", "--force", "--no-force"], env: { COLUMNS: "80" }, edit: edited },
      {
        args: ["install", "--dest", "./relative//nested/../skills/"],
        env: { FORCE_COLOR: "1", COLUMNS: "31" },
      },
      {
        args: ["install", "--dest", "wide"],
        env: { FORCE_COLOR: "1", NO_COLOR: "1", COLUMNS: "120" },
      },
      { args: ["install", "--dest", "narrow"], env: { FORCE_COLOR: "", COLUMNS: "19" } },
      { args: ["install", "--dest", "zero"], env: { FORCE_COLOR: "0", COLUMNS: "80" } },
      { args: ["install", "--dest", "zero-width"], env: { COLUMNS: "0" } },
      {
        args: ["install", "--dest", "./~/alternate"],
        env: { FORCE_COLOR: "1", TERM: "dumb", COLUMNS: "18" },
      },
    ];
    const input = runs.map(({ args, env, edit }) => ({
      source,
      cwd,
      args,
      edit,
      env: { ...safeEnv, ...env },
    }));
    const oracle = spawnSync(PYTHON, [join(REPO, "apps/host/test-fixtures/skills-oracle.py")], {
      cwd: REPO,
      env: safeEnv,
      input: JSON.stringify(input),
      encoding: "utf8",
    });
    expect(oracle.status, oracle.stderr).toBe(0);
    const expected = JSON.parse(oracle.stdout) as {
      code: number;
      stdout: string;
      stderr: string;
    }[];
    const expectedCwd = tree(cwd);
    const expectedHome = tree(home);
    const expectedTimes = copiedTimes(join(cwd, "wide"));
    rmSync(cwd, { recursive: true });
    mkdirSync(cwd);
    rmSync(home, { recursive: true });
    mkdirSync(home);
    for (const [index, run] of runs.entries()) {
      if (run.edit) writeFileSync(run.edit, "synthetic owner edit\n");
      const actual = { code: 0 as unknown, stdout: "", stderr: "" };
      const io: CommandIo = {
        cwd,
        paths: { home },
        env: run.env,
        tty: { stdin: false, stdout: false, stderr: false },
        signal: new AbortController().signal,
        t: createTranslator("en"),
        stdout: (s) => {
          actual.stdout += s;
        },
        stderr: (s) => {
          actual.stderr += s;
        },
        prompt: async () => null,
        stdin: async function* () {},
      };
      actual.code = await skillsCommand(source).run(run.args, io, {});
      expect(actual, `case ${index}`).toEqual(expected[index]);
    }
    expect(tree(cwd)).toEqual(expectedCwd);
    expect(tree(home)).toEqual(expectedHome);
    expect(copiedTimes(join(cwd, "wide"))).toEqual(expectedTimes);
  },
);
