// The private-file checks per platform: exact POSIX modes and owners on macOS / Linux, type-only on
// Windows (synthetic modes), path comparison without case on Windows, and the Windows stand-ins for
// O_NOFOLLOW and directory fsync.
// Synthetic temp dirs only.
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import {
  hasNoGroupOrOtherBits,
  hasPosixModes,
  hasPrivateMode,
  isOwnerOnly,
  O_NOFOLLOW,
  openedWithoutLink,
  sameFile,
  samePath,
  syncDirectory,
  syncPrivateDirectory,
} from "./privateFs.js";

afterEach(cleanup);

const ON_WINDOWS = process.platform === "win32";
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const stat = (mode: number, owner = uid) => ({ mode: 0o100000 | mode, uid: owner });
const dirStat = (mode: number, owner = uid) => ({ mode: 0o040000 | mode, uid: owner });

describe("private modes", () => {
  it("compares exact POSIX permission bits and the owner on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(hasPosixModes(platform)).toBe(true);
      expect(hasPrivateMode(stat(0o600), 0o600, platform)).toBe(true);
      expect(hasPrivateMode(stat(0o644), 0o600, platform)).toBe(false);
      expect(hasPrivateMode(stat(0o700), 0o600, platform)).toBe(false);
      expect(isOwnerOnly(stat(0o700), platform)).toBe(true);
      expect(isOwnerOnly(stat(0o710), platform)).toBe(false);
      expect(isOwnerOnly(stat(0o704), platform)).toBe(false);
      expect(hasPrivateMode(dirStat(0o700), 0o700, platform)).toBe(true);
      expect(hasPrivateMode(dirStat(0o750), 0o700, platform)).toBe(false);
      expect(hasPrivateMode(stat(0o400), 0o600, platform)).toBe(false);
    }
  });

  it("checks only group and other bits, not the owner, for hasNoGroupOrOtherBits", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(hasNoGroupOrOtherBits(dirStat(0o700), platform)).toBe(true);
      expect(hasNoGroupOrOtherBits(stat(0o400, uid + 1), platform)).toBe(true);
      expect(hasNoGroupOrOtherBits(stat(0o640), platform)).toBe(false);
      expect(hasNoGroupOrOtherBits(dirStat(0o701), platform)).toBe(false);
    }
    expect(hasNoGroupOrOtherBits(dirStat(0o777), "win32")).toBe(true);
  });

  it.skipIf(ON_WINDOWS)("refuses another user's file on macOS and Linux", () => {
    expect(hasPrivateMode(stat(0o600, uid + 1), 0o600, "linux")).toBe(false);
    expect(isOwnerOnly(stat(0o700, uid + 1), "darwin")).toBe(false);
  });

  it("skips the synthetic modes and owners Node reports on Windows", () => {
    expect(hasPosixModes("win32")).toBe(false);
    // A writable file reads as 0666, a read-only one as 0444; neither says who may read it.
    expect(hasPrivateMode(stat(0o666), 0o600, "win32")).toBe(true);
    expect(hasPrivateMode(stat(0o444, uid + 1), 0o600, "win32")).toBe(true);
    expect(isOwnerOnly(stat(0o777), "win32")).toBe(true);
    expect(hasPrivateMode(dirStat(0o666, 0), 0o700, "win32")).toBe(true);
  });

  it("checks this platform's real files", () => {
    const dir = trackDir(tempDir());
    const file = join(dir, "f");
    writeFileSync(file, "synthetic", { mode: 0o600 });
    mkdirSync(join(dir, "d"), { mode: 0o700 });
    expect(hasPrivateMode(lstatSync(file), 0o600)).toBe(true);
    expect(isOwnerOnly(lstatSync(join(dir, "d")))).toBe(true);
  });
});

describe("path comparison", () => {
  it("compares exactly on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(samePath("/Users/anna/cashU", "/Users/anna/cashU", platform)).toBe(true);
      expect(samePath("/Users/anna/cashU", "/users/anna/cashu", platform)).toBe(false);
      expect(samePath("/a/b", "/a/b/", platform)).toBe(false);
    }
  });

  it("ignores letter case on Windows, nothing else", () => {
    expect(samePath("C:\\Users\\Anna\\cashU", "c:\\users\\anna\\CASHU", "win32")).toBe(true);
    expect(samePath("C:\\Apps\\cashU.exe", "C:\\Apps\\other.exe", "win32")).toBe(false);
    // No normalization: a short (8.3) name or another separator is another spelling.
    expect(samePath("C:\\PROGRA~1\\cashU", "C:\\Program Files\\cashU", "win32")).toBe(false);
    expect(samePath("C:/Apps/cashU", "C:\\Apps\\cashU", "win32")).toBe(false);
  });
});

describe("links and directory sync", () => {
  it("names one file by device and inode", () => {
    const dir = trackDir(tempDir());
    writeFileSync(join(dir, "a"), "a");
    writeFileSync(join(dir, "b"), "b");
    const a = lstatSync(join(dir, "a"));
    expect(sameFile(a, lstatSync(join(dir, "a")))).toBe(true);
    expect(sameFile(a, lstatSync(join(dir, "b")))).toBe(false);
  });

  it("accepts a file opened from its own path, and refuses a missing path", () => {
    const dir = trackDir(tempDir());
    const file = join(dir, "f");
    writeFileSync(file, "synthetic");
    expect(openedWithoutLink(file, lstatSync(file))).toBe(true);
    // Where O_NOFOLLOW exists the open already refused links, so the path is not looked at again.
    expect(openedWithoutLink(join(dir, "gone"), lstatSync(file))).toBe(O_NOFOLLOW !== 0);
  });

  it.runIf(ON_WINDOWS)(
    "refuses on Windows a path that names another file than the one opened",
    () => {
      expect(O_NOFOLLOW).toBe(0);
      const dir = trackDir(tempDir());
      writeFileSync(join(dir, "a"), "a");
      writeFileSync(join(dir, "b"), "b");
      expect(openedWithoutLink(join(dir, "a"), lstatSync(join(dir, "b")))).toBe(false);
    },
  );

  it("never opens a directory to sync it on Windows", () => {
    const dir = trackDir(tempDir());
    // A missing directory shows that nothing is opened.
    expect(() => syncDirectory(join(dir, "missing"), "win32")).not.toThrow();
    expect(() => syncDirectory(dir)).not.toThrow();
  });

  it.skipIf(ON_WINDOWS)("fsyncs a directory on macOS and Linux", () => {
    const dir = trackDir(tempDir());
    expect(() => syncDirectory(dir, "linux")).not.toThrow();
    expect(() => syncDirectory(join(dir, "missing"))).toThrow();
  });

  it("never opens a private directory to sync it on Windows", () => {
    expect(syncPrivateDirectory(join(trackDir(tempDir()), "absent"), "win32")).toBe(true);
  });

  it.skipIf(ON_WINDOWS)("fsyncs only this user's 0700 directory on macOS and Linux", () => {
    const root = trackDir(tempDir());
    const path = join(root, "private");
    mkdirSync(path, { mode: 0o700 });
    expect(syncPrivateDirectory(path)).toBe(true);
    chmodSync(path, 0o750);
    expect(syncPrivateDirectory(path)).toBe(false);
    expect(() => syncPrivateDirectory(join(root, "absent"))).toThrow(/ENOENT/);
  });
});
