// The one-time removal of the LAN carrier's folder (`<data dir>/lan-carrier`) at host start: only that
// exact entry, only a real directory, never through or along a symlink. Temp dirs and synthetic bytes.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeLegacyLanCarrier } from "./paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "cashu-lan-carrier-"));
  roots.push(root);
  return root;
}

/** A data dir with a vault folder and the old carrier copy (`<vault>/<device>/<n>.seg`). */
function dataDirWithCarrier(): string {
  const dataDir = join(temp(), "data");
  mkdirSync(join(dataDir, "stores", "vaults"), { recursive: true });
  writeFileSync(join(dataDir, "stores", "vaults", "keep.bin"), "vault");
  const segments = join(dataDir, "lan-carrier", "a".repeat(32), "b".repeat(32));
  mkdirSync(segments, { recursive: true, mode: 0o700 });
  writeFileSync(join(segments, "0.seg"), new Uint8Array([1, 2, 3]));
  return dataDir;
}

it("removes the old carrier folder and nothing else of the data dir; a second start finds none", () => {
  const dataDir = dataDirWithCarrier();
  // Only the exact name: a sibling with a similar name stays.
  mkdirSync(join(dataDir, "lan-carrier-old"));
  expect(removeLegacyLanCarrier(dataDir)).toBe("removed");
  expect(existsSync(join(dataDir, "lan-carrier"))).toBe(false);
  expect(existsSync(join(dataDir, "lan-carrier-old"))).toBe(true);
  expect(readFileSync(join(dataDir, "stores", "vaults", "keep.bin"), "utf8")).toBe("vault");
  expect(removeLegacyLanCarrier(dataDir)).toBe("absent");
});

it("never follows a symlink: inside the folder it unlinks the link, outside targets stay", () => {
  const dataDir = dataDirWithCarrier();
  const outside = join(temp(), "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "precious.txt"), "keep");
  symlinkSync(outside, join(dataDir, "lan-carrier", "escape"));
  expect(removeLegacyLanCarrier(dataDir)).toBe("removed");
  expect(existsSync(join(dataDir, "lan-carrier"))).toBe(false);
  expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep");
});

it("leaves a lan-carrier symlink (and its target) alone, and anything that is not a directory", () => {
  const dataDir = join(temp(), "data");
  mkdirSync(dataDir);
  const outside = join(temp(), "elsewhere");
  mkdirSync(outside);
  writeFileSync(join(outside, "precious.txt"), "keep");
  symlinkSync(outside, join(dataDir, "lan-carrier"));
  expect(removeLegacyLanCarrier(dataDir)).toBe("skipped");
  expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep");
  expect(existsSync(join(dataDir, "lan-carrier"))).toBe(true);

  const fileDir = join(temp(), "data");
  mkdirSync(fileDir);
  writeFileSync(join(fileDir, "lan-carrier"), "not a folder");
  expect(removeLegacyLanCarrier(fileDir)).toBe("skipped");
  expect(readFileSync(join(fileDir, "lan-carrier"), "utf8")).toBe("not a folder");
  // A relative data dir is never resolved against the working directory.
  expect(removeLegacyLanCarrier("relative/data")).toBe("skipped");
});
