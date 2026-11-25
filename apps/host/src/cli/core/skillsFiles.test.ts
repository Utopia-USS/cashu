// The path arithmetic of `cashu skills install` under both path rules, by injecting `win32` /
// `posix`: the Windows spelling and resolution run on any OS (the filesystem steps do not).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { createTranslator } from "@cashu/i18n";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import { skillsCommand } from "./skills.js";
import {
  expandHome,
  filesystemPath,
  homeRelative,
  pathSpelling,
  strictlyInside,
} from "./skillsFiles.js";

describe("POSIX rules (unchanged)", () => {
  it("spells like pathlib and joins the cwd without resolving ..", () => {
    expect(pathSpelling("./a//b/../c/", posix)).toBe("a/b/../c");
    expect(pathSpelling("C:\\a\\b", posix)).toBe("C:\\a\\b");
    expect(homeRelative("~\\x", posix)).toBe(false);
    expect(expandHome("~/a", "/home/anna/", posix)).toBe("/home/anna/a");
    expect(filesystemPath("/work", "link/../skills", posix)).toBe("/work/link/../skills");
    expect(filesystemPath("/work", "/abs", posix)).toBe("/abs");
  });

  it("tells a nested destination from the source itself and its siblings", () => {
    expect(strictlyInside("/s/alpha", "/s/alpha/x", posix)).toBe(true);
    expect(strictlyInside("/s/alpha", "/s/alpha", posix)).toBe(false);
    expect(strictlyInside("/s/alpha", "/s/alpha-2", posix)).toBe(false);
    expect(strictlyInside("/s/alpha", "/s", posix)).toBe(false);
  });
});

describe("Windows rules", () => {
  it("spells with backslashes and keeps the drive or UNC root and ..", () => {
    expect(pathSpelling("C:/Users//anna/./.claude/skills/", win32)).toBe(
      "C:\\Users\\anna\\.claude\\skills",
    );
    expect(pathSpelling("//nas/home/x/../y", win32)).toBe("\\\\nas\\home\\x\\..\\y");
    expect(pathSpelling("~/.claude/skills", win32)).toBe("~\\.claude\\skills");
    expect(pathSpelling("D:skills", win32)).toBe("D:skills");
    expect(pathSpelling("./", win32)).toBe(".");
  });

  it("expands ~ with either separator into the caller's Windows home", () => {
    expect(homeRelative(pathSpelling("~/a", win32), win32)).toBe(true);
    expect(homeRelative(pathSpelling("~\\a", win32), win32)).toBe(true);
    expect(homeRelative(pathSpelling("~anna\\a", win32), win32)).toBe(false);
    expect(expandHome("~/.claude/skills", "C:\\Users\\anna\\", win32)).toBe(
      "C:\\Users\\anna\\.claude\\skills",
    );
    expect(expandHome("~", "\\\\nas\\home\\anna", win32)).toBe("\\\\nas\\home\\anna");
  });

  it("resolves against the cwd like the OS, and refuses another drive's relative path", () => {
    expect(filesystemPath("C:\\work", "skills\\..\\x", win32)).toBe("C:\\work\\x");
    expect(filesystemPath("C:\\work", "D:\\skills", win32)).toBe("D:\\skills");
    expect(filesystemPath("C:\\work", "\\skills", win32)).toBe("C:\\skills");
    expect(filesystemPath("\\\\nas\\home\\w", "\\skills", win32)).toBe("\\\\nas\\home\\skills");
    expect(filesystemPath("C:\\work", "c:skills", win32)).toBe("c:\\work\\skills");
    expect(filesystemPath("C:\\work", "D:skills", win32)).toBeUndefined();
    expect(filesystemPath("\\\\nas\\home\\w", "C:skills", win32)).toBeUndefined();
  });

  it("compares containment case-insensitively and across drives", () => {
    expect(strictlyInside("C:\\App\\skills\\alpha", "c:\\app\\SKILLS\\alpha\\x", win32)).toBe(true);
    expect(strictlyInside("C:\\App\\skills\\alpha", "C:\\App\\skills\\alpha", win32)).toBe(false);
    expect(strictlyInside("C:\\App\\skills\\alpha", "D:\\App\\skills\\alpha\\x", win32)).toBe(
      false,
    );
    expect(strictlyInside("C:\\App\\skills\\alpha", "C:\\App\\skills\\alphabet", win32)).toBe(
      false,
    );
  });
});

describe("`cashu skills install` refusals under Windows rules", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const run = async (dest: string, cwd: string) => {
    const source = mkdtempSync(join(tmpdir(), "cashu-skills-win-"));
    dirs.push(source);
    const output = { stdout: "", stderr: "" };
    const io: CommandIo = {
      cwd,
      paths: { home: "C:\\Users\\anna" },
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
    const code = await skillsCommand(source, win32).run(["install", "--dest", dest], io, {});
    return { code, ...output };
  };

  it("refuses another user's home and another drive's relative path before any write", async () => {
    expect(await run("~anna\\skills", "C:\\work")).toEqual({
      code: 2,
      stdout: "",
      stderr: "--dest expands only ~ and ~/. Give another user's folder as a full path.\n",
    });
    const drive = await run("D:skills", "C:\\work");
    expect(drive.code).toBe(2);
    expect(drive.stderr).toContain("D:skills");
    expect(drive.stdout).toBe("");
  });
});
