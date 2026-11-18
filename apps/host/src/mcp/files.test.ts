import { closeSync, mkdirSync, openSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ToolError } from "@cashu/mcp";
import { linkDir, linkFile } from "@cashu/node-host/testing/links";
import { afterEach, expect, it } from "vitest";
import { cleanup, tempDir } from "../testing/harness.js";
import { budgetFileReader, investmentFileReader, investmentMappingReader } from "./files.js";

afterEach(cleanup);
it("keeps budget extensions unchanged and grants only the explicit investment/profile-only mapping capabilities", () => {
  const f = fixture(),
    scope = { cwd: f.cwd, home: f.home, dataDir: f.dataDir, legacyDataDir: f.legacyDataDir };
  const read = investmentFileReader(scope),
    workspace = join(f.root, "profile-workspace"),
    mapping = investmentMappingReader({
      ...scope,
      profileOnlyRoot: workspace,
      profileOnlySlug: "demo",
    });
  for (const extension of ["csv", "tsv", "txt", "json", "xlsx"]) {
    const path = f.file(join(f.cwd, `export.${extension}`));
    expect(read(path, "demo").name).toBe(`export.${extension}`);
    if (!["csv", "json"].includes(extension))
      expect(() => f.read(path, "demo")).toThrow("unsupported file type");
  }
  const own = f.file(join(workspace, "map.yaml"));
  expect(mapping(own, "demo")).toBe("synthetic");
  expect(() => mapping(own, "other")).toThrow("native workspace mapping is unavailable");
  const outside = f.file(join(f.cwd, "map.yml"));
  expect(() => mapping(outside, "demo")).toThrow("must be in the selected profile's workspace");
  // A linked folder inside the workspace (a junction on Windows) does not widen it.
  linkDir(f.cwd, join(workspace, "linked"));
  expect(() => mapping(join(workspace, "linked", "map.yml"), "demo")).toThrow(
    "must be in the selected profile's workspace",
  );
  truncateSync(own, 256 * 1024 + 1);
  expect(() => mapping(own, "demo")).toThrow("mapping file is too large");
  for (const path of [
    f.file(join(f.dataDir, "profiles", "other", "private.xlsx")),
    f.file(join(f.legacyDataDir, "private.xlsx")),
    f.file(join(f.cwd, ".hidden", "private.xlsx")),
  ])
    expect(() => read(path, "demo")).toThrow();
});

it("confines native mapping YAML to the checked workspace root", () => {
  const f = fixture();
  const workspace = join(f.root, "native-workspace");
  const mapping = investmentMappingReader({
    cwd: f.cwd,
    home: f.home,
    dataDir: f.dataDir,
    profileOnlyRoot: workspace,
    profileOnlySlug: "demo",
  });
  const own = f.file(join(workspace, "mapping.yaml"));
  expect(mapping(own, "demo")).toBe("synthetic");
  expect(() => mapping(f.file(join(f.cwd, "mapping.yaml")), "demo")).toThrow(
    "must be in the selected profile's workspace",
  );
});
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
it("checks the target of a linked folder (a junction on Windows), including hidden and foreign profile targets", () => {
  const f = fixture();
  f.file(join(f.home, ".private", "sample.json"));
  linkDir(join(f.home, ".private"), join(f.cwd, "public"));
  expect(() => f.read(join(f.cwd, "public", "sample.json"), "demo")).toThrow("hidden files");
  f.file(join(f.dataDir, "profiles", "other", "sample.json"));
  linkDir(join(f.dataDir, "profiles", "other"), join(f.cwd, "other"));
  expect(() => f.read(join(f.cwd, "other", "sample.json"), "demo")).toThrow(
    "files inside the cashU data dir",
  );
  f.file(join(f.legacyDataDir, "sample.json"));
  linkDir(f.legacyDataDir, join(f.cwd, "legacy"));
  expect(() => f.read(join(f.cwd, "legacy", "sample.json"), "demo")).toThrow(
    "files inside the legacy data folder are not read",
  );
});
// File symlinks; on a Windows runner without the privilege to create them the test skips itself.
it("checks the symlink target, including hidden and foreign profile targets", ({ skip }) => {
  const f = fixture();
  const hidden = f.file(join(f.home, ".private", "sample.json"));
  const alias = join(f.cwd, "public.json");
  linkFile(hidden, alias, skip);
  expect(() => f.read(alias, "demo")).toThrow("hidden files");
  const other = f.file(join(f.dataDir, "profiles", "other", "sample.json"));
  const alias2 = join(f.cwd, "other.json");
  linkFile(other, alias2, skip);
  expect(() => f.read(alias2, "demo")).toThrow("files inside the cashU data dir");
  const workspace = join(f.root, "profile-workspace");
  const mapping = investmentMappingReader({
    cwd: f.cwd,
    home: f.home,
    dataDir: f.dataDir,
    profileOnlyRoot: workspace,
    profileOnlySlug: "demo",
  });
  const alias3 = join(workspace, "alias.yaml");
  mkdirSync(workspace);
  linkFile(f.file(join(f.cwd, "map.yml")), alias3, skip);
  expect(() => mapping(alias3, "demo")).toThrow("must be in the selected profile's workspace");
});
it("refuses an oversized file before allocating its contents", () => {
  const f = fixture();
  const path = join(f.cwd, "large.csv");
  closeSync(openSync(path, "w"));
  truncateSync(path, 20 * 1024 * 1024 + 1);
  expect(() => f.read(path, "demo")).toThrow("file is too large (max 20 MB)");
});
it("on Windows reads only drive-letter paths, refused as text before anything resolves them", () => {
  const f = fixture();
  const scope = { cwd: "C:\\work", home: "C:\\Users\\synthetic", dataDir: f.dataDir };
  const read = budgetFileReader({ ...scope, platform: "win32" });
  const refused = new ToolError("only files on a local drive are read");
  // A refusal, not "file not found": nothing tried to resolve the path (an SMB connection for UNC).
  for (const path of [
    "\\\\attacker\\share\\x.csv",
    "//attacker/share/x.csv",
    "\\\\?\\UNC\\attacker\\share\\x.csv",
    "\\\\.\\pipe\\x.csv",
    "\\x.csv",
    "C:x.csv",
    "C:\\data\\NUL.csv",
    "x.csv:stream",
  ])
    expect(() => read(path, "demo")).toThrow(refused);
  // A relative path under a share, and a home on a share, are refused the same way.
  expect(() =>
    budgetFileReader({ ...scope, cwd: "\\\\attacker\\share", platform: "win32" })("x.csv", "demo"),
  ).toThrow(refused);
  expect(() =>
    budgetFileReader({ ...scope, home: "\\\\attacker\\home", platform: "win32" })(
      "~\\x.csv",
      "demo",
    ),
  ).toThrow(refused);
  // A drive-letter path passes the check and is then resolved (missing here).
  for (const path of ["C:\\nowhere\\x.csv", "nowhere\\x.csv", "~\\nowhere\\x.csv"])
    expect(() => read(path, "demo")).toThrow(new ToolError("file not found", "not_found"));
});
