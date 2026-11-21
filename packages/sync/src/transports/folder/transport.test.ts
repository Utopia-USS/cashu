import { describe, expect, it } from "vitest";
import { TransportError } from "../../errors.js";
import { parseSegmentName, segmentFileName } from "./names.js";
import { MemoryFolderFs } from "./testing/memory-fs.js";
import { FolderTransport } from "./transport.js";

const VAULT = "f01de4f01de4f01de4f01de4f01de4f0";
const A = "a1".repeat(16);
const B = "b2".repeat(16);
const dirA = `${VAULT}/${A}`;
const bytes = (...xs: number[]) => Uint8Array.from(xs);

async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof TransportError ? e.code : `other:${String(e)}`;
  }
}

describe("folder file names", () => {
  it("recognises segments, conflict copies, placeholders and temp files", () => {
    expect(segmentFileName(3)).toBe("000003.seg");
    expect(parseSegmentName("000003.seg")).toEqual({ kind: "canonical", seg: 3 });
    for (const copy of [
      "000003 (1).seg",
      "000003 2.seg",
      "000003.sync-conflict-20261031-120000-ABCDEFG.seg",
      "000003 (conflicted copy 2026-10-31).seg",
      "000003-HOSTNAME.seg",
      "3.seg",
    ]) {
      expect(parseSegmentName(copy)).toEqual({ kind: "copy", seg: 3 });
    }
    expect(parseSegmentName(".000003.seg.icloud")).toEqual({ kind: "evicted", seg: 3 });
    expect(parseSegmentName(".000003 2.seg.icloud")).toEqual({ kind: "evicted", seg: 3 });
    expect(parseSegmentName(".000003.seg.k3x9a.tmp")).toEqual({ kind: "temp", seg: 3 });
    for (const foreign of [
      ".DS_Store",
      ".syncthing.000003.seg.tmp",
      "notes.txt",
      "x3.seg",
      "Icon\r",
    ]) {
      expect(parseSegmentName(foreign)).toBeUndefined();
    }
  });
});

describe("folder transport", () => {
  it("appends by writing a temp file and renaming it over the segment", async () => {
    const fs = new MemoryFolderFs();
    const seen: string[] = [];
    const spy = new Proxy(fs, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (prop === "write" || prop === "rename")
            seen.push(`${String(prop)} ${String(args[0])}`);
          return v.apply(target, args);
        };
      },
    });
    const t = new FolderTransport({ fs: spy, owner: A });
    await t.append(VAULT, A, 1, 0, bytes(1, 2, 3));
    await t.append(VAULT, A, 1, 3, bytes(4));
    expect(seen.every((s) => /\/\.000001\.seg\.[0-9a-z]+\.tmp$/.test(s))).toBe(true);
    expect(seen).toHaveLength(4);
    expect(fs.paths()).toEqual([`${dirA}/000001.seg`]);
    expect([...(await t.read(VAULT, A, 1, 1))]).toEqual([2, 3, 4]);
    expect(await t.list(VAULT)).toEqual([{ device: A, seg: 1, size: 4 }]);
  });

  it("refuses to write another device's directory", async () => {
    const t = new FolderTransport({ fs: new MemoryFolderFs(), owner: A });
    await expect(t.append(VAULT, B, 1, 0, bytes(1))).rejects.toThrow(RangeError);
    await expect(t.append("../escape", A, 1, 0, bytes(1))).rejects.toThrow(RangeError);
  });

  it("merges prefix-consistent conflict copies into the longest version", async () => {
    const fs = new MemoryFolderFs();
    const reader = new FolderTransport({ fs, owner: B });
    // iCloud kept the older version as the file and the newer one as a copy.
    fs.put(`${dirA}/000001.seg`, bytes(1, 2, 3));
    fs.put(`${dirA}/000001 2.seg`, bytes(1, 2, 3, 4, 5));
    fs.put(`${dirA}/000001.sync-conflict-20261031-120000-ABCDEFG.seg`, bytes(1, 2));
    expect(await reader.list(VAULT)).toEqual([{ device: A, seg: 1, size: 5 }]);
    expect([...(await reader.read(VAULT, A, 1, 3))]).toEqual([4, 5]);
    expect(reader.status().conflictCopies).toEqual([{ device: A, seg: 1 }]);
    expect(reader.status().forks).toEqual([]);
    // The writer's next append continues from the merged version and removes the copies.
    const writer = new FolderTransport({ fs, owner: A });
    expect(await errorCode(writer.append(VAULT, A, 1, 3, bytes(9)))).toBe("offset-conflict");
    await writer.append(VAULT, A, 1, 5, bytes(6));
    expect(fs.paths()).toEqual([`${dirA}/000001.seg`]);
    expect([...(fs.get(`${dirA}/000001.seg`) ?? [])]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("shows only the common prefix of diverging versions, reports the fork, refuses to append", async () => {
    const fs = new MemoryFolderFs();
    const t = new FolderTransport({ fs, owner: A });
    fs.put(`${dirA}/000002.seg`, bytes(1, 2, 3, 4));
    fs.put(`${dirA}/000002 (1).seg`, bytes(1, 2, 9, 9, 9));
    expect(await t.list(VAULT)).toEqual([{ device: A, seg: 2, size: 2 }]);
    expect([...(await t.read(VAULT, A, 2, 0))]).toEqual([1, 2]);
    expect(t.status().forks).toEqual([{ device: A, seg: 2 }]);
    expect(await errorCode(t.append(VAULT, A, 2, 2, bytes(5)))).toBe("offset-conflict");
    expect(fs.paths()).toHaveLength(2);
  });

  it("reports evicted iCloud placeholders and ignores foreign files and temp leftovers", async () => {
    const fs = new MemoryFolderFs();
    const t = new FolderTransport({ fs, owner: A });
    fs.put(`${VAULT}/${B}/000001.seg`, bytes(7));
    fs.put(`${VAULT}/${B}/.000002.seg.icloud`, bytes(0));
    fs.put(`${VAULT}/${B}/.DS_Store`, bytes(0));
    fs.put(`${VAULT}/not-a-device/000001.seg`, bytes(1));
    fs.put(`${dirA}/.000001.seg.crashed1.tmp`, bytes(1, 2));
    expect(await t.list(VAULT)).toEqual([{ device: B, seg: 1, size: 1 }]);
    expect(t.status().evicted).toEqual([{ device: B, seg: 2 }]);
    // A crash left a temp file between write and rename: the next append cleans it up.
    await t.append(VAULT, A, 1, 0, bytes(5));
    expect(fs.paths().filter((p) => p.startsWith(dirA))).toEqual([`${dirA}/000001.seg`]);
  });

  it("reports an unreachable folder as unavailable, an empty vault as empty", async () => {
    const fs = new MemoryFolderFs();
    const t = new FolderTransport({ fs, owner: A });
    expect(await t.list(VAULT)).toEqual([]);
    expect((await t.read(VAULT, A, 1, 0)).length).toBe(0);
    fs.setOnline(false);
    expect(await errorCode(t.list(VAULT))).toBe("unavailable");
    expect(await errorCode(t.append(VAULT, A, 1, 0, bytes(1)))).toBe("unavailable");
  });

  it("an empty append writes nothing", async () => {
    const fs = new MemoryFolderFs();
    const t = new FolderTransport({ fs, owner: A });
    await t.append(VAULT, A, 1, 0, new Uint8Array(0));
    expect(fs.paths()).toEqual([]);
  });
});
