import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostLanCarrier } from "./carrier.js";

const vault = "a".repeat(32);
const writer = "b".repeat(32);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("atomically serves a default-size opaque segment with canonical names and exact offsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "cashu-lan-carrier-"));
  dirs.push(root);
  const carrier = new HostLanCarrier(root);
  const first = new Uint8Array(4 * 1024 * 1024 + 17).fill(0x5a);
  expect(await carrier.append(vault, writer, 1, 0, first)).toBe(first.length);
  expect(await carrier.list(vault)).toEqual([{ device: writer, seg: 1, size: first.length }]);
  expect((await carrier.read(vault, writer, 1, 0)).length).toBe(first.length);
  expect([...(await carrier.read(vault, writer, 1, first.length - 2))]).toEqual([0x5a, 0x5a]);
  await expect(carrier.append(vault, writer, 1, 0, Uint8Array.of(0x7b))).rejects.toThrow(
    "carrier_offset_conflict",
  );
  expect((await readFile(join(root, vault, writer, "000001.seg"))).length).toBe(first.length);
  expect(await carrier.append(vault, writer, 1, first.length, Uint8Array.of(0x7b))).toBe(
    first.length + 1,
  );
  expect([...(await carrier.read(vault, writer, 1, first.length))]).toEqual([0x7b]);
});

it("refuses symlinked carrier directories before following opaque bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cashu-lan-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "cashu-lan-outside-"));
  dirs.push(root, outside);
  await symlink(outside, join(root, vault));
  const carrier = new HostLanCarrier(root);
  await expect(carrier.append(vault, writer, 1, 0, Uint8Array.of(1))).rejects.toThrow(
    "carrier_invalid",
  );
  await expect(carrier.list(vault)).rejects.toThrow("carrier_invalid");
});
