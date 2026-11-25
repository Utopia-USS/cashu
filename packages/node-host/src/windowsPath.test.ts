import { describe, expect, it } from "vitest";
import { isLocalDrivePath, winIsAbsolute } from "./windowsPath.js";

describe("winIsAbsolute", () => {
  it("knows fully qualified paths", () => {
    for (const path of ["C:\\", "c:/x", "\\\\server\\share", "//server/share"])
      expect(winIsAbsolute(path)).toBe(true);
    for (const path of ["C:", "C:x", "\\x", "/x", "x", "", "~"])
      expect(winIsAbsolute(path)).toBe(false);
  });
});

describe("isLocalDrivePath", () => {
  it("accepts a path on a drive letter, either separator", () => {
    for (const path of [
      "C:\\",
      "c:/x.csv",
      "D:\\Users\\Jan Kowalski\\wyciąg (1).csv",
      "C:\\a\\..\\b\\.hidden\\x.json",
      "C:\\data\\console.csv",
      "C:\\data\\NULL.csv",
      "C:\\data\\COM10.csv",
    ])
      expect(isLocalDrivePath(path)).toBe(true);
  });

  it("refuses UNC, device and namespace paths", () => {
    for (const path of [
      "\\\\attacker\\share\\x.csv",
      "//attacker/share/x.csv",
      "\\/attacker/share/x.csv",
      "\\\\?\\C:\\x.csv",
      "\\\\?\\UNC\\attacker\\share\\x.csv",
      "\\\\.\\pipe\\cashu",
      "\\??\\C:\\x.csv",
    ])
      expect(isLocalDrivePath(path)).toBe(false);
  });

  it("refuses rooted, drive-relative and relative paths", () => {
    for (const path of ["\\x.csv", "/x.csv", "C:x.csv", "C:", "x.csv", "~\\x.csv", ""])
      expect(isLocalDrivePath(path)).toBe(false);
  });

  it("refuses NTFS streams, NUL and DOS device names in any segment", () => {
    for (const path of [
      "C:\\x.csv:hidden",
      "C:\\x.csv::$DATA",
      "C:\\x\0.csv",
      "C:\\NUL",
      "C:\\data\\nul.csv",
      "C:\\data\\COM1.csv",
      "C:\\data\\lpt9",
      "C:\\data\\com¹.txt",
      "C:\\CON \\x.csv",
      "C:/aux/x.csv",
      "C:\\data\\CONOUT$",
    ])
      expect(isLocalDrivePath(path)).toBe(false);
  });
});
