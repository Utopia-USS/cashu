import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toCurrency } from "@cashu/domain/investments";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { canonicalJson } from "@cashu/store";
import { DeviceStore } from "@cashu/store/device";
import type { SourceCacheReceipt } from "@cashu/store/genesis/verification";
import {
  NotificationQueue,
  SqlCalendarCache,
  SqlGlobalCatalog,
  SqlPriceCache,
} from "@cashu/store/investments/local";
import { afterEach, expect, it } from "vitest";
import { MigrationError } from "./contract.js";
import type { StrictConversion } from "./convert.js";
import { hydrateLocalState, verifyHydratedLocalState } from "./localState.js";
import { sealPythonSource } from "./sourceSeal.js";

const roots: string[] = [];
const CALENDAR =
  '{"fetched_at":"2026-01-02T03:04:05+00:00","from":"2026-01-02","to":"2026-01-09","macro":[],"earnings":[],"errors":[]}\n';
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { conversion: StrictConversion; target: string; vault: string } {
  const source = realpathSync(mkdtempSync(join(tmpdir(), "cashu-local-source-")));
  const target = realpathSync(mkdtempSync(join(tmpdir(), "cashu-local-target-")));
  roots.push(source, target);
  mkdirSync(join(source, "market"), { mode: 0o700 });
  writeFileSync(join(source, "market", "calendar.json"), CALENDAR, { mode: 0o600 });
  const db = new DatabaseSync(join(source, "cashu.db"));
  try {
    db.exec(`CREATE TABLE inv_instruments (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE inv_instrument_aliases (
      id INTEGER PRIMARY KEY, instrument_id INTEGER NOT NULL, namespace TEXT NOT NULL,
      value TEXT NOT NULL);
      CREATE TABLE mcp_calls (
        id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, tool TEXT NOT NULL,
        privacy TEXT NOT NULL, called_at TEXT NOT NULL, args TEXT NOT NULL,
        outcome TEXT NOT NULL, error_kind TEXT, duration_ms INTEGER NOT NULL);
      CREATE TABLE connector_runs (
        id INTEGER PRIMARY KEY, connector_id TEXT NOT NULL, profile_id INTEGER,
        binding_id INTEGER, command TEXT NOT NULL, started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL, error_kind TEXT,
        exit_code INTEGER, records INTEGER NOT NULL, bytes_in INTEGER NOT NULL,
        bytes_out INTEGER NOT NULL, denied_hosts_json TEXT NOT NULL, stderr_tail TEXT,
        proposal_id INTEGER, batch_ref TEXT);`);
    db.prepare("INSERT INTO inv_instrument_aliases VALUES (?,?,?,?)").run(1, 1, "yahoo", "SYN");
    db.prepare("INSERT INTO inv_instrument_aliases VALUES (?,?,?,?)").run(2, 3, "yahoo", "ORPH");
    db.prepare("INSERT INTO inv_instruments VALUES (?,?)").run(1, "Synthetic A");
    db.prepare("INSERT INTO inv_instruments VALUES (?,?)").run(2, "Synthetic B");
    db.prepare("INSERT INTO inv_instruments VALUES (?,?)").run(3, "Unreferenced synthetic");
    db.prepare("INSERT INTO mcp_calls VALUES (?,?,?,?,?,?,?,?,?)").run(
      7,
      1,
      "synthetic.tool",
      "strict",
      "2026-01-02 03:04:05.000000",
      '{"flag":"boolean"}',
      "ok",
      null,
      12,
    );
    db.prepare("INSERT INTO connector_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      3,
      "synthetic-connector",
      null,
      null,
      "check",
      "2026-01-02 03:04:05.000000",
      20,
      "ok",
      null,
      0,
      0,
      0,
      0,
      "[]",
      "synthetic redacted tail",
      null,
      null,
    );
  } finally {
    db.close();
  }
  chmodSync(join(source, "cashu.db"), 0o600);
  const receipt: SourceCacheReceipt = {
    format: 1,
    schema: "0029_sync_inbound",
    priceBars: [
      {
        id: 1,
        instrumentId: 1,
        date: "2026-01-02",
        close: "12.5",
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: "PLN",
        source: "yahoo",
        fetchedAt: null,
      },
      {
        id: 2,
        instrumentId: 2,
        date: "2026-01-02",
        close: "3.7",
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: null,
        source: "manual",
        fetchedAt: null,
      },
      {
        id: 3,
        instrumentId: 3,
        date: "2026-01-02",
        close: "5.1",
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: "PLN",
        source: "yahoo",
        fetchedAt: null,
      },
    ],
    fxRates: [
      {
        id: 1,
        base: "EUR",
        quote: "USD",
        date: "2026-01-02",
        rate: "1.07",
        source: "nbp",
        fetchedAt: null,
      },
    ],
    macroBars: [
      {
        id: 1,
        series: "growth",
        date: "2026-01-02",
        close: "101.2",
        source: "yahoo",
        fetchedAt: null,
      },
    ],
  };
  const vault = "a".repeat(32);
  const conversion = {
    snapshot: sealPythonSource(source),
    genesis: {
      schema: receipt.schema,
      vaults: [
        {
          ordinal: 0,
          profileId: 1,
          vault,
          ids: [
            { table: "inv_instruments", localId: "1", gid: "b".repeat(32) },
            { table: "inv_instruments", localId: "2", gid: "c".repeat(32) },
          ],
          deviceLocal: {
            notifications: [
              {
                signal: "d".repeat(32),
                severity: "action",
                createdAt: "2026-01-02T03:04:05Z",
                sentAt: "2026-01-02T03:05:05Z",
                channel: "macos",
              },
              {
                signal: "f".repeat(32),
                severity: "watch",
                createdAt: "2026-01-03T03:04:05Z",
                sentAt: null,
                channel: null,
              },
            ],
            connectorFetch: [
              {
                binding: "e".repeat(32),
                lastRunAt: null,
                lastStatus: "ok",
                lastOkAt: "2026-01-02T03:05:05Z",
                backoffUntil: null,
              },
            ],
          },
        },
      ],
    },
    cacheReceipt: {
      format: 1,
      digest: createHash("sha256").update(canonicalJson(receipt)).digest("hex"),
      bytes: Buffer.byteLength(canonicalJson(receipt)),
      priceBars: 3,
      fxRates: 1,
      macroBars: 1,
      receipt,
    },
  } as unknown as StrictConversion;
  return { conversion, target, vault };
}

it("hydrates, reopens and compares exact offline cache and device-local history", async () => {
  const { conversion, target, vault } = fixture();
  const path = join(target, "device.db");
  const first = openNodeSqlite(path);
  let proof: ReturnType<typeof hydrateLocalState>;
  try {
    DeviceStore.open(first);
    proof = hydrateLocalState(first, conversion);
    expect(proof).toMatchObject({
      priceBars: 3,
      globalInstruments: 1,
      globalAliases: 1,
      fxRates: 1,
      macroBars: 1,
      notifications: 2,
      connectorFetch: 1,
      mcpCalls: 1,
      connectorRuns: 1,
    });
    expect(proof.calendarBytes).toBe(new TextEncoder().encode(CALENDAR).length);
  } finally {
    first.close();
  }
  const reopened = openNodeSqlite(path);
  try {
    DeviceStore.open(reopened);
    verifyHydratedLocalState(reopened, conversion, proof);
    expect(reopened.prepare("SELECT id,tool,args FROM mcp_calls").all()).toEqual([
      { id: 7, tool: "synthetic.tool", args: '{"flag":"boolean"}' },
    ]);
    expect(
      reopened.prepare("SELECT id,vault,stderr_tail AS stderrTail FROM connector_runs").all(),
    ).toEqual([{ id: 3, vault: null, stderrTail: "synthetic redacted tail" }]);
    const prices = new SqlPriceCache(reopened);
    expect(prices.bars({ provider: "yahoo", symbol: "SYN" })[0]?.close.toString()).toBe("12.5");
    expect(prices.barsForInstrument(vault, "c".repeat(32))[0]?.close.toString()).toBe("3.7");
    expect(prices.bars({ provider: "yahoo", symbol: "ORPH" })[0]?.close.toString()).toBe("5.1");
    expect(new SqlGlobalCatalog(reopened).rows()).toHaveLength(2);
    reopened
      .prepare(
        "UPDATE local_source_global_catalog SET source_json=? WHERE kind='instrument' AND id=3",
      )
      .run('{"id":3,"name":"Changed synthetic"}');
    expect(() => verifyHydratedLocalState(reopened, conversion, proof)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
    reopened
      .prepare(
        "UPDATE local_source_global_catalog SET source_json=? WHERE kind='instrument' AND id=3",
      )
      .run('{"id":3,"name":"Unreferenced synthetic"}');
    expect(prices.ratesForBase("nbp", "EUR", toCurrency("USD"))[0]?.fetchedAt).toBeNull();
    expect(prices.macroBars("growth")[0]?.close.toString()).toBe("101.2");
    const calendar = new SqlCalendarCache(reopened);
    expect(calendar.rawBytes()).toEqual(new TextEncoder().encode(CALENDAR));
    await expect(calendar.read()).resolves.toMatchObject({ from: "2026-01-02", macro: [] });
    const notifications = new NotificationQueue(reopened);
    expect(notifications.has(vault, "d".repeat(32), "action")).toBe(true);
    expect(notifications.history(vault)[0]?.channel).toBe("macos");
    expect(notifications.pending(vault)).toHaveLength(1);
    expect(notifications.enqueue(vault, "d".repeat(32), "action", "2026-01-04T00:00:00Z")).toBe(
      false,
    );
    expect(notifications.enqueue(vault, "f".repeat(32), "watch", "2026-01-04T00:00:00Z")).toBe(
      false,
    );
    expect(
      notifications.enqueue("g".repeat(32), "d".repeat(32), "action", "2026-01-04T00:00:00Z"),
    ).toBe(true);
    expect(notifications.connectorFetch(vault)[0]?.lastStatus).toBe("ok");
    reopened
      .prepare("INSERT INTO local_market_bars(provider,symbol,date,close) VALUES (?,?,?,?)")
      .run("yahoo", "SYN", "2026-01-02", "99.9");
    expect(() => verifyHydratedLocalState(reopened, conversion, proof)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
    reopened.prepare("DELETE FROM local_market_bars").run();
    reopened
      .prepare("INSERT INTO local_market_bar_masks(provider,symbol,date) VALUES (?,?,?)")
      .run("yahoo", "SYN", "2026-01-02");
    expect(() => verifyHydratedLocalState(reopened, conversion, proof)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
    reopened.prepare("DELETE FROM local_market_bar_masks").run();
    reopened
      .prepare("UPDATE local_market_calendar SET content=? WHERE id=1")
      .run(
        new TextEncoder().encode(
          '{"fetched_at":"2026-01-02T03:04:05+00:00","from":"2026-01-02","to":"2026-01-09","macro":[1],"earnings":[],"errors":[]}\n',
        ),
      );
    expect(() => verifyHydratedLocalState(reopened, conversion, proof)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
    reopened
      .prepare("UPDATE local_market_calendar SET content=? WHERE id=1")
      .run(new TextEncoder().encode(CALENDAR));
    reopened.prepare("UPDATE local_source_price_bars SET close=? WHERE id=1").run("99.9");
    expect(() => verifyHydratedLocalState(reopened, conversion, proof)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
    reopened.prepare("UPDATE local_source_price_bars SET close=? WHERE id=1").run("12.5");
    reopened.prepare("UPDATE mcp_calls SET args=? WHERE id=7").run('{"flag":"string"}');
    expect(() => verifyHydratedLocalState(reopened, conversion, proof)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
    reopened.prepare("UPDATE mcp_calls SET args=? WHERE id=7").run('{"flag":"boolean"}');
    reopened.prepare("UPDATE connector_runs SET stderr_tail=? WHERE id=3").run("changed");
    expect(() => verifyHydratedLocalState(reopened, conversion, proof)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
  } finally {
    reopened.close();
  }
});

it("rolls back cache and history together when a local row cannot be restored", () => {
  const { conversion, target } = fixture();
  const original = conversion.genesis.vaults[0];
  if (!original) throw new Error("fixture vault missing");
  const invalid = {
    ...conversion,
    genesis: {
      ...conversion.genesis,
      vaults: [
        {
          ...original,
          deviceLocal: {
            ...original.deviceLocal,
            notifications: [
              ...original.deviceLocal.notifications,
              original.deviceLocal.notifications[0],
            ],
          },
        },
      ],
    },
  } as StrictConversion;
  const driver = openNodeSqlite(join(target, "device.db"));
  try {
    DeviceStore.open(driver);
    expect(() => hydrateLocalState(driver, invalid)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
    expect(
      new SqlPriceCache(driver).sourceCacheRows(conversion.genesis.schema).priceBars,
    ).toHaveLength(0);
    expect(new NotificationQueue(driver).history(original.vault)).toHaveLength(0);
  } finally {
    driver.close();
  }
});
