import { closeSync, mkdirSync, openSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ToolError } from "@cashu/mcp";
import { afterEach, expect, it } from "vitest";
import { cleanup, tempDir } from "../testing/harness.js";
import { budgetFileReader } from "./files.js";

afterEach(cleanup);
function fixture() {
  const root = tempDir();
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const legacyDataDir = join(root, "legacy");
  for (const dir of [cwd, home, dataDir]) mkdirSync(dir);
  const read = budgetFileReader({ cwd, home, dataDir, legacyDataDir });
  const file = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "synthetic");
    return path;
  };
  return { root, cwd, home, dataDir, legacyDataDir, read, file };
}
it("reads bytes from the session cwd and home with case-insensitive suffixes", () => {
  const f = fixture();
  f.file(join(f.cwd, "sample.CSV"));
  f.file(join(f.home, "sample.json"));
  expect(f.read("sample.CSV", "demo")).toEqual({
    name: "sample.CSV",
    bytes: Buffer.from("synthetic"),
  });
  expect(f.read("~/sample.json", "demo").name).toBe("sample.json");
});
it("uses a named-user lookup and never treats an unknown user as a literal relative path", () => {
  const f = fixture();
  const read = budgetFileReader({
    cwd: f.cwd,
    home: f.home,
    dataDir: f.dataDir,
    legacyDataDir: f.legacyDataDir,
    namedHome: (name) => (name === "synthetic" ? f.home : undefined),
  });
  f.file(join(f.home, "sample.json"));
  f.file(join(f.cwd, "~missing", "sample.json"));
  expect(read("~synthetic/sample.json", "demo").name).toBe("sample.json");
  expect(() => read("~missing/sample.json", "demo")).toThrow(
    new ToolError("file not found", "not_found"),
  );
});
it("refuses missing, hidden, nonregular and unsupported files with fixed errors", () => {
  const f = fixture();
  for (const path of ["", "bad\0.json"])
    expect(() => f.read(path, "demo")).toThrow("path is required");
  expect(() => f.read("missing.json", "demo")).toThrow(
    new ToolError("file not found", "not_found"),
  );
  expect(() => f.read(f.cwd, "demo")).toThrow("not a regular file");
  expect(() => f.read(f.file(join(f.cwd, "sample.txt")), "demo")).toThrow(
    "unsupported file type; allowed: json, csv",
  );
  expect(() => f.read(f.file(join(f.cwd, ".private", "sample.json")), "demo")).toThrow(
    "hidden files and files inside hidden directories are not read",
  );
});
it("allows only the current profile exception and always rejects the legacy directory", () => {
  const f = fixture();
  const own = f.file(join(f.dataDir, "profiles", "demo", "sample.json"));
  expect(f.read(own, "demo").name).toBe("sample.json");
  expect(() => f.read(own, "renamed")).toThrow(
    "files inside the cashU data dir are not read (except the profile folder)",
  );
  expect(() => f.read(f.file(join(f.dataDir, "sample.json")), "demo")).toThrow(
    "files inside the cashU data dir are not read",
  );
  expect(() => f.read(f.file(join(f.legacyDataDir, "sample.json")), "demo")).toThrow(
    "files inside the legacy data folder are not read",
  );
});
it("uses NFC and full casefold containment, not only lowercase or string prefixes", () => {
  const f = fixture();
  const guarded = budgetFileReader({
    cwd: f.cwd,
    home: f.home,
    dataDir: join(f.root, "Straße"),
    legacyDataDir: f.legacyDataDir,
  });
  expect(() => guarded(f.file(join(f.root, "STRASSE", "sample.json")), "demo")).toThrow(
    "files inside the cashU data dir are not read",
  );
  expect(guarded(f.file(join(f.root, "STRASSE-more", "sample.json")), "demo").name).toBe(
    "sample.json",
  );
  const normalized = budgetFileReader({
    cwd: f.cwd,
    home: f.home,
    dataDir: join(f.root, "café"),
    legacyDataDir: f.legacyDataDir,
  });
  expect(() => normalized(f.file(join(f.root, "cafe\u0301", "sample.json")), "demo")).toThrow(
    "files inside the cashU data dir are not read",
  );
});
it("checks the symlink target, including hidden and foreign profile targets", () => {
  const f = fixture();
  const hidden = f.file(join(f.home, ".private", "sample.json"));
  const alias = join(f.cwd, "public.json");
  symlinkSync(hidden, alias);
  expect(() => f.read(alias, "demo")).toThrow("hidden files");
  const other = f.file(join(f.dataDir, "profiles", "other", "sample.json"));
  const alias2 = join(f.cwd, "other.json");
  symlinkSync(other, alias2);
  expect(() => f.read(alias2, "demo")).toThrow("files inside the cashU data dir");
});
it("refuses an oversized file before allocating its contents", () => {
  const f = fixture();
  const path = join(f.cwd, "large.csv");
  closeSync(openSync(path, "w"));
  truncateSync(path, 20 * 1024 * 1024 + 1);
  expect(() => f.read(path, "demo")).toThrow("file is too large (max 20 MB)");
});
