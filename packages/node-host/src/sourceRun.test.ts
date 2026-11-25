// The Node flags a source run hands on to a process it starts: POSIX keeps the exact absolute path of a
// relative `--import` (byte-identical to before Windows), Windows gets a `file:` URL.
import { expect, it } from "vitest";
import { sourceRunFlags } from "./sourceRun.js";

it("keeps the exact absolute --import path of a source run on POSIX", () => {
  const argv = [
    "--experimental-strip-types",
    "--import",
    "./tools/node-ts/resolveTs.ts",
    "--import=../loader.ts",
    "--import",
    "tsx",
    "--inspect",
  ];
  for (const platform of ["darwin", "linux"] as const) {
    expect(sourceRunFlags(argv, "/repo/cashu", platform)).toEqual([
      "--experimental-transform-types",
      "--import",
      "/repo/cashu/tools/node-ts/resolveTs.ts",
      "--import=/repo/loader.ts",
      "--import",
      "tsx",
    ]);
  }
});

it("hands Windows Node a file URL for a relative --import (C:\\ is not a specifier there)", () => {
  const argv = [
    "--import",
    "./tools/node-ts/resolveTs.ts",
    "--import=../a b#1.ts",
    "--import",
    "tsx",
  ];
  expect(sourceRunFlags(argv, "C:\\Users\\anna\\cashu", "win32")).toEqual([
    "--import",
    "file:///C:/Users/anna/cashu/tools/node-ts/resolveTs.ts",
    "--import=file:///C:/Users/anna/a%20b%231.ts",
    "--import",
    "tsx",
  ]);
  expect(sourceRunFlags(["--import", "./l.ts"], "\\\\nas\\dev\\cashu", "win32")).toEqual([
    "--import",
    "file://nas/dev/cashu/l.ts",
  ]);
});
