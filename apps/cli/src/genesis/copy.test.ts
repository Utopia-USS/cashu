// The source side of a run (S26 spec 8.5, 9.4): golden.py manifest semantics, the run copy, the
// side files genesis reads from it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertUnchanged, copyRun, manifest, runFiles, SourceChangedError } from "./copy.ts";
import { tempDir, writePythonDataDir } from "./testing/pythonDataDir.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("source manifest", () => {
  it("hashes `<sha256>  ./<rel>` lines in code point order, symlinked files in, symlinked dirs not walked", () => {
    const root = tempDir("manifest");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "z.txt"), "z");
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "A.txt"), "A");
    symlinkSync(join(root, "b.txt"), join(root, "lf"));
    symlinkSync(join(root, "a"), join(root, "ld"));
    const lines = [
      `${sha("A")}  ./A.txt\n`,
      `${sha("z")}  ./a/z.txt\n`,
      `${sha("b")}  ./b.txt\n`,
      `${sha("b")}  ./lf\n`,
    ];
    expect(manifest(root)).toEqual({ files: 4, sha256: sha(lines.join("")) });
  });

  it("fails on any change", () => {
    const root = tempDir("manifest");
    writeFileSync(join(root, "x"), "1");
    const before = manifest(root);
    expect(() => assertUnchanged(before, manifest(root))).not.toThrow();
    writeFileSync(join(root, "x"), "2");
    expect(() => assertUnchanged(before, manifest(root))).toThrow(SourceChangedError);
    writeFileSync(join(root, "x"), "1");
    writeFileSync(join(root, "y"), "");
    expect(() => assertUnchanged(before, manifest(root))).toThrow(SourceChangedError);
  });
});

describe("run copy", () => {
  it("copies the database and the profiles / imports folders only, leaving the source as it was", () => {
    const base = tempDir("copy");
    const data = join(base, "data");
    writePythonDataDir(data);
    const before = manifest(data);
    const run = join(base, "run");
    copyRun(data, run);
    expect(manifest(data)).toEqual(before);
    expect(existsSync(join(run, "cashu.db"))).toBe(true);
    expect(existsSync(join(run, "profiles", "ala", "budget.json"))).toBe(true);
    expect(existsSync(join(run, "imports", "ala", "notes.txt"))).toBe(true);
    expect(existsSync(join(run, "backups"))).toBe(false);
  });

  it("reads side files inside the copy only", () => {
    const base = tempDir("copy");
    writePythonDataDir(join(base, "data"));
    writeFileSync(join(base, "outside.txt"), "x");
    const run = join(base, "run");
    copyRun(join(base, "data"), run);
    const files = runFiles(run);
    expect(new TextDecoder().decode(files.read("imports/ala/notes.txt"))).toBe("synthetic\n");
    expect(files.read("imports/ala/missing.txt")).toBeUndefined();
    expect(files.read("../outside.txt")).toBeUndefined();
    expect(files.read(join(base, "outside.txt"))).toBeUndefined();
    expect(files.read("imports/ala")).toBeUndefined();
    expect(files.list("imports/ala")).toEqual(["notes.txt"]);
    expect(files.list("imports")).toEqual([]);
    expect(files.list("imports/nobody")).toEqual([]);
    expect(files.list("..")).toEqual([]);
  });
});
