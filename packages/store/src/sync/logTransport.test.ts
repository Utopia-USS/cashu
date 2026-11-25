/// <reference types="node" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransportError } from "@cashu/sync";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import type { SqlDriver } from "../sql/driver.js";
import { SqlLogTransport } from "./logTransport.js";

const VAULT = "c0ffee00c0ffee00c0ffee00c0ffee00";
const A = "a".repeat(32);
const B = "b".repeat(32);

const drivers: SqlDriver[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(path = ":memory:"): SqlLogTransport {
  const driver = betterSqlite3Driver(new Database(path));
  drivers.push(driver);
  const transport = new SqlLogTransport({ driver, vault: VAULT });
  transport.ensureSchema();
  return transport;
}

const bytes = (...values: number[]) => new Uint8Array(values);
const code = (error: unknown) => (error instanceof TransportError ? error.code : String(error));

describe("SqlLogTransport", () => {
  it("is linearizable and starts empty", async () => {
    const t = open();
    expect(t.consistency).toEqual({ kind: "linearizable" });
    expect(await t.list(VAULT)).toEqual([]);
    expect((await t.read(VAULT, A, 1, 0)).length).toBe(0);
  });

  it("appends chunks at the segment size and reads any offset across chunk borders", async () => {
    const t = open();
    await t.append(VAULT, A, 1, 0, bytes(1, 2, 3));
    await t.append(VAULT, A, 1, 3, bytes(4, 5));
    await t.append(VAULT, A, 1, 5, bytes(6));
    expect(await t.list(VAULT)).toEqual([{ device: A, seg: 1, size: 6 }]);
    for (let from = 0; from <= 6; from++) {
      expect([...(await t.read(VAULT, A, 1, from))]).toEqual([1, 2, 3, 4, 5, 6].slice(from));
    }
    expect((await t.read(VAULT, A, 1, 99)).length).toBe(0);
  });

  it("rejects a stale or future offset with offset-conflict and writes nothing", async () => {
    const t = open();
    await t.append(VAULT, A, 1, 0, bytes(1, 2, 3));
    for (const at of [0, 2, 4]) {
      expect(code(await t.append(VAULT, A, 1, at, bytes(9)).catch((e) => e))).toBe(
        "offset-conflict",
      );
    }
    expect(code(await t.append(VAULT, A, 2, 1, bytes(9)).catch((e) => e))).toBe("offset-conflict");
    expect(await t.list(VAULT)).toEqual([{ device: A, seg: 1, size: 3 }]);
    expect([...(await t.read(VAULT, A, 1, 0))]).toEqual([1, 2, 3]);
  });

  it("keeps devices and segments apart", async () => {
    const t = open();
    await t.append(VAULT, A, 1, 0, bytes(7, 7));
    await t.append(VAULT, B, 1, 0, bytes(8));
    await t.append(VAULT, B, 2, 0, bytes(9));
    const sorted = [...(await t.list(VAULT))].sort((x, y) =>
      x.device === y.device ? x.seg - y.seg : x.device < y.device ? -1 : 1,
    );
    expect(sorted).toEqual([
      { device: A, seg: 1, size: 2 },
      { device: B, seg: 1, size: 1 },
      { device: B, seg: 2, size: 1 },
    ]);
    expect([...(await t.read(VAULT, B, 2, 0))]).toEqual([9]);
  });

  it("does not alias the caller's buffers", async () => {
    const t = open();
    const input = bytes(1, 2);
    await t.append(VAULT, A, 1, 0, input);
    input[0] = 42;
    const out = await t.read(VAULT, A, 1, 0);
    out[1] = 42;
    expect([...(await t.read(VAULT, A, 1, 0))]).toEqual([1, 2]);
  });

  it("refuses another vault, bad ids, offsets and empty appends", async () => {
    const t = open();
    const other = "0badbeef0badbeef0badbeef0badbeef";
    await expect(t.list(other)).rejects.toThrow("log_transport_vault");
    await expect(t.read(other, A, 1, 0)).rejects.toThrow("log_transport_vault");
    await expect(t.append(other, A, 1, 0, bytes(1))).rejects.toThrow("log_transport_vault");
    await expect(t.append(VAULT, "A".repeat(32), 1, 0, bytes(1))).rejects.toThrow("log_device");
    await expect(t.read(VAULT, "short", 1, 0)).rejects.toThrow("log_device");
    for (const seg of [0, -1, 1.5]) {
      await expect(t.append(VAULT, A, seg, 0, bytes(1))).rejects.toThrow("log_segment");
    }
    await expect(t.append(VAULT, A, 1, -1, bytes(1))).rejects.toThrow("log_offset");
    await expect(t.read(VAULT, A, 1, 0.5)).rejects.toThrow("log_offset");
    await expect(t.append(VAULT, A, 1, 0, bytes())).rejects.toThrow("log_append_empty");
    expect(await t.list(VAULT)).toEqual([]);
  });

  it("persists across a reopen of the same database file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cashu-log-"));
    dirs.push(dir);
    const path = join(dir, "log.db");
    const first = open(path);
    await first.append(VAULT, A, 1, 0, bytes(1, 2));
    await first.append(VAULT, A, 1, 2, bytes(3));
    drivers.pop()?.close();
    const again = open(path);
    expect(await again.list(VAULT)).toEqual([{ device: A, seg: 1, size: 3 }]);
    expect([...(await again.read(VAULT, A, 1, 1))]).toEqual([2, 3]);
    await again.append(VAULT, A, 1, 3, bytes(4));
    expect([...(await again.read(VAULT, A, 1, 0))]).toEqual([1, 2, 3, 4]);
  });
});
