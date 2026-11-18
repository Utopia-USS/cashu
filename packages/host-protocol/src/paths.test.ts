import { expect, it } from "vitest";
import { isAbsoluteCwd, pathFlavor } from "./paths.js";

it("maps a Node platform to its path rules", () => {
  expect(pathFlavor("win32")).toBe("win32");
  for (const platform of ["darwin", "linux", "freebsd"]) expect(pathFlavor(platform)).toBe("posix");
});

it("keeps the POSIX rule: a leading slash, no NUL", () => {
  expect(isAbsoluteCwd("/", "posix")).toBe(true);
  expect(isAbsoluteCwd("/Users/anna/work", "posix")).toBe(true);
  for (const path of ["", "work", "./work", "~/work", "C:\\work", "/a\u0000b"])
    expect(isAbsoluteCwd(path, "posix")).toBe(false);
});

it("takes only fully qualified Windows directories", () => {
  for (const path of ["C:\\", "z:/", "C:\\a b\\c", "\\\\server\\share", "//server/share/dir"])
    expect(isAbsoluteCwd(path, "win32")).toBe(true);
  for (const path of [
    "C:",
    "C:dir",
    "\\dir",
    "/dir",
    "\\\\server",
    "\\\\\\share",
    "\\\\?\\C:\\dir",
    "//./pipe/x",
    "C:\\a\u0000b",
  ])
    expect(isAbsoluteCwd(path, "win32")).toBe(false);
});
