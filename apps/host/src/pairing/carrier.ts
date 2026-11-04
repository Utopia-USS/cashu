import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { LAN_MAX_APPEND_BYTES, LAN_MAX_READ_BYTES } from "@cashu/host-protocol/pairing-lan";
import type { SegmentInfo } from "@cashu/sync";

const ID = /^[0-9a-f]{32}$/;
const SEG = /^([0-9]{6,10})\.seg$/;
const MAX_SEGMENTS = 65_536;
const segmentName = (seg: number) => `${String(seg).padStart(6, "0")}.seg`;

function valid(vault: string, device?: string, seg?: number): void {
  if (
    !ID.test(vault) ||
    (device !== undefined && !ID.test(device)) ||
    (seg !== undefined && (!Number.isSafeInteger(seg) || seg < 1 || seg > 2_147_483_647))
  )
    throw new Error("carrier_invalid");
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("carrier_invalid");
}

async function privateBytes(path: string): Promise<Buffer> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("carrier_invalid");
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("carrier_invalid");
    if (info.size > LAN_MAX_READ_BYTES) throw new Error("carrier_too_large");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** Opaque LAN mirror, separate from the engine's local log. All calls enter the vault queue. */
export class HostLanCarrier {
  readonly #root: string;
  constructor(root: string) {
    this.#root = root;
  }

  async list(vault: string): Promise<readonly SegmentInfo[]> {
    valid(vault);
    await privateDirectory(this.#root, false);
    try {
      await privateDirectory(join(this.#root, vault), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let writers: string[];
    try {
      writers = await readdir(join(this.#root, vault));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (writers.length > MAX_SEGMENTS) throw new Error("carrier_too_large");
    const result: SegmentInfo[] = [];
    for (const writer of writers) {
      if (!ID.test(writer)) continue;
      await privateDirectory(join(this.#root, vault, writer), false);
      const names = await readdir(join(this.#root, vault, writer));
      if (names.length + result.length > MAX_SEGMENTS) throw new Error("carrier_too_large");
      for (const name of names) {
        const match = SEG.exec(name);
        if (!match) continue;
        const seg = Number(match[1]);
        if (!Number.isSafeInteger(seg) || seg > 2_147_483_647 || segmentName(seg) !== name)
          continue;
        const info = await lstat(join(this.#root, vault, writer, name));
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
          throw new Error("carrier_invalid");
        if (info.size > LAN_MAX_READ_BYTES) throw new Error("carrier_too_large");
        result.push({ device: writer, seg, size: info.size });
      }
    }
    return result;
  }

  async read(vault: string, writer: string, seg: number, offset: number): Promise<Uint8Array> {
    valid(vault, writer, seg);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("carrier_invalid");
    await privateDirectory(this.#root, false);
    try {
      await privateDirectory(join(this.#root, vault), false);
      await privateDirectory(join(this.#root, vault, writer), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Uint8Array();
      throw error;
    }
    const path = join(this.#root, vault, writer, segmentName(seg));
    let bytes: Buffer;
    try {
      bytes = await privateBytes(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Uint8Array();
      throw error;
    }
    if (bytes.length > LAN_MAX_READ_BYTES) throw new Error("carrier_too_large");
    return bytes.subarray(Math.min(offset, bytes.length));
  }

  async append(
    vault: string,
    writer: string,
    seg: number,
    offset: number,
    bytes: Uint8Array,
  ): Promise<number> {
    valid(vault, writer, seg);
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length > LAN_MAX_APPEND_BYTES)
      throw new Error("carrier_too_large");
    await privateDirectory(this.#root, false);
    await privateDirectory(join(this.#root, vault), true);
    const dir = join(this.#root, vault, writer);
    await privateDirectory(dir, true);
    const path = join(dir, segmentName(seg));
    let original: Buffer;
    try {
      original = await privateBytes(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") original = Buffer.alloc(0);
      else throw error;
    }
    if (original.length !== offset) throw new Error("carrier_offset_conflict");
    if (original.length + bytes.length > LAN_MAX_READ_BYTES) throw new Error("carrier_too_large");
    const temporary = join(dir, `.${seg}.${randomBytes(12).toString("hex")}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(original);
      await file.writeFile(bytes);
      await file.sync();
    } catch (error) {
      await file.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await file.close();
    try {
      await rename(temporary, path);
      const parent = await open(dir, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return original.length + bytes.length;
  }
}
