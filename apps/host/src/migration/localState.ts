import { createHash } from "node:crypto";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { canonicalJson, type SqlDriver } from "@cashu/store";
import {
  type ConnectorRunRecord,
  ensureConnectorRunHistory,
  restoreConnectorRuns,
} from "@cashu/store/device";
import {
  NotificationQueue,
  type SourceGlobalCatalogRow,
  type SourcePriceAlias,
  type SourcePriceIdentity,
  SqlCalendarCache,
  SqlGlobalCatalog,
  SqlPriceCache,
} from "@cashu/store/investments/local";
import { MigrationError } from "./contract.js";
import { filesOf, type StrictConversion } from "./convert.js";
import { assertSameSource, sealPythonSource } from "./sourceSeal.js";

export interface LocalStateProof {
  readonly format: 1;
  readonly digest: string;
  readonly priceBars: number;
  readonly fxRates: number;
  readonly macroBars: number;
  readonly calendarBytes: number;
  readonly calendarSha256: string | null;
  readonly mcpCalls: number;
  readonly connectorRuns: number;
  readonly globalInstruments: number;
  readonly globalAliases: number;
  readonly notifications: number;
  readonly connectorFetch: number;
}

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function sourceCalendarBytes(conversion: StrictConversion): Uint8Array | null {
  assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  const entry = conversion.snapshot.entries.find((item) => item.path === "market/calendar.json");
  if (!entry) return null;
  const bytes = filesOf(conversion.snapshot.root, conversion.snapshot).read("market/calendar.json");
  if (!bytes || bytes.length !== entry.bytes) throw new MigrationError("source_changed");
  assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  return Uint8Array.from(bytes);
}

const encoded = (bytes: Uint8Array | null) =>
  bytes === null ? null : Buffer.from(bytes).toString("base64");

interface SourceMcpCall {
  readonly id: number;
  readonly vault: string;
  readonly tool: string;
  readonly privacy: string;
  readonly calledAt: string;
  readonly args: string;
  readonly outcome: string;
  readonly errorKind: string | null;
  readonly durationMs: number;
}

function sourceMcpCalls(conversion: StrictConversion): readonly SourceMcpCall[] {
  assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  const source = openNodeSqlite(join(conversion.snapshot.root, "cashu.db"), { readOnly: true });
  try {
    const vaults = new Map(
      conversion.genesis.vaults.map((vault) => [vault.profileId, vault.vault]),
    );
    const rows = source
      .prepare(
        `SELECT id,profile_id AS profileId,tool,privacy,called_at AS calledAt,args,outcome,
              error_kind AS errorKind,duration_ms AS durationMs
       FROM mcp_calls ORDER BY id`,
      )
      .all<{
        id: number;
        profileId: number;
        tool: string;
        privacy: string;
        calledAt: string;
        args: string;
        outcome: string;
        errorKind: string | null;
        durationMs: number;
      }>();
    return rows.map(({ profileId, ...row }) => {
      const vault = vaults.get(profileId);
      let args: unknown;
      try {
        args = JSON.parse(row.args);
      } catch {
        throw new MigrationError("mapping_invalid");
      }
      if (
        !vault ||
        !Number.isSafeInteger(row.id) ||
        row.id <= 0 ||
        typeof row.tool !== "string" ||
        !row.tool ||
        !["strict", "amounts"].includes(row.privacy) ||
        typeof row.calledAt !== "string" ||
        !row.calledAt ||
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        !["ok", "error", "refused", "started"].includes(row.outcome) ||
        (row.errorKind !== null && typeof row.errorKind !== "string") ||
        !Number.isSafeInteger(row.durationMs) ||
        row.durationMs < 0
      )
        throw new MigrationError("mapping_invalid");
      return { ...row, vault };
    });
  } finally {
    source.close();
    assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  }
}

function sourceConnectorRuns(conversion: StrictConversion): readonly ConnectorRunRecord[] {
  assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  const source = openNodeSqlite(join(conversion.snapshot.root, "cashu.db"), { readOnly: true });
  try {
    const vaults = new Map(
      conversion.genesis.vaults.map((vault) => [vault.profileId, vault.vault]),
    );
    const rows = source
      .prepare(
        `SELECT id,connector_id AS connectorId,profile_id AS legacyProfileId,
        binding_id AS bindingId,command,started_at AS startedAt,duration_ms AS durationMs,
        outcome,error_kind AS errorKind,exit_code AS exitCode,records,
        bytes_in AS bytesIn,bytes_out AS bytesOut,denied_hosts_json AS deniedHostsJson,
        stderr_tail AS stderrTail,proposal_id AS proposalId,batch_ref AS batchRef
       FROM connector_runs ORDER BY id`,
      )
      .all<Omit<ConnectorRunRecord, "vault">>();
    return rows.map((row) => {
      const vault = row.legacyProfileId === null ? null : vaults.get(row.legacyProfileId);
      if (vault === undefined) throw new MigrationError("mapping_invalid");
      return { ...row, vault };
    });
  } finally {
    source.close();
    assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  }
}

function sourceMappings(conversion: StrictConversion): {
  readonly identities: readonly SourcePriceIdentity[];
  readonly aliases: readonly SourcePriceAlias[];
  readonly globalCatalog: readonly SourceGlobalCatalogRow[];
} {
  assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  const source = openNodeSqlite(join(conversion.snapshot.root, "cashu.db"), { readOnly: true });
  try {
    const mapped = new Set(
      conversion.genesis.vaults.flatMap((vault) =>
        vault.ids
          .filter((entry) => entry.table === "inv_instruments")
          .map((entry) => Number(entry.localId)),
      ),
    );
    const sourceInstruments = source
      .prepare("SELECT * FROM inv_instruments ORDER BY id")
      .all<Record<string, unknown>>();
    const instrumentIds = new Set(sourceInstruments.map((row) => row.id));
    const sourceAliases = source
      .prepare("SELECT * FROM inv_instrument_aliases ORDER BY id")
      .all<Record<string, unknown>>();
    if (
      sourceInstruments.some(
        (row) => typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0,
      ) ||
      sourceAliases.some(
        (row) =>
          typeof row.id !== "number" ||
          !Number.isSafeInteger(row.id) ||
          row.id <= 0 ||
          !instrumentIds.has(row.instrument_id),
      )
    )
      throw new MigrationError("mapping_invalid");
    const rawJson = (row: Record<string, unknown>): string => {
      if (
        Object.values(row).some(
          (value) => value !== null && typeof value !== "string" && typeof value !== "number",
        )
      )
        throw new MigrationError("mapping_invalid");
      return canonicalJson(row);
    };
    const globalCatalog: SourceGlobalCatalogRow[] = [
      ...sourceInstruments
        .filter((row) => !mapped.has(row.id as number))
        .map((row) => ({
          kind: "instrument" as const,
          id: row.id as number,
          sourceJson: rawJson(row),
        })),
      ...sourceAliases
        .filter((row) => !mapped.has(row.instrument_id as number))
        .map((row) => ({ kind: "alias" as const, id: row.id as number, sourceJson: rawJson(row) })),
    ].sort((a, b) => compare(a.kind, b.kind) || a.id - b.id);
    const aliases = source
      .prepare(
        "SELECT instrument_id AS instrumentId,namespace AS provider,value AS symbol FROM inv_instrument_aliases ORDER BY id",
      )
      .all<SourcePriceAlias>()
      .sort(
        (a, b) =>
          a.instrumentId - b.instrumentId ||
          compare(a.provider, b.provider) ||
          compare(a.symbol, b.symbol),
      );
    const identities = conversion.genesis.vaults
      .flatMap((vault) =>
        vault.ids
          .filter((entry) => entry.table === "inv_instruments")
          .map((entry) => ({
            instrumentId: Number(entry.localId),
            vault: vault.vault,
            gid: entry.gid,
          })),
      )
      .sort((a, b) => compare(a.vault, b.vault) || a.instrumentId - b.instrumentId);
    if (
      identities.some(
        (entry) => !Number.isSafeInteger(entry.instrumentId) || entry.instrumentId <= 0,
      ) ||
      conversion.cacheReceipt.receipt.priceBars.some((bar) => !instrumentIds.has(bar.instrumentId))
    ) {
      throw new MigrationError("mapping_invalid");
    }
    return { identities, aliases, globalCatalog };
  } finally {
    source.close();
    assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
  }
}

function stateOf(driver: SqlDriver, conversion: StrictConversion): unknown {
  const cache = new SqlPriceCache(driver);
  const notifications = new NotificationQueue(driver);
  const calendar = new SqlCalendarCache(driver);
  const globalCatalog = new SqlGlobalCatalog(driver);
  return {
    cache: cache.sourceCacheRows(conversion.genesis.schema),
    calendar: encoded(calendar.rawBytes()),
    overlays: cache.importOverlayState(),
    mappings: cache.sourceMappings(),
    globalCatalog: globalCatalog.rows(),
    mcpCalls: driver
      .prepare(
        `SELECT id,vault,tool,privacy,called_at AS calledAt,args,outcome,
              error_kind AS errorKind,duration_ms AS durationMs FROM mcp_calls ORDER BY id`,
      )
      .all<SourceMcpCall>(),
    connectorRuns: driver
      .prepare(
        `SELECT id,connector_id AS connectorId,vault,
        legacy_profile_id AS legacyProfileId,binding_id AS bindingId,command,
        started_at AS startedAt,duration_ms AS durationMs,outcome,
        error_kind AS errorKind,exit_code AS exitCode,records,
        bytes_in AS bytesIn,bytes_out AS bytesOut,denied_hosts_json AS deniedHostsJson,
        stderr_tail AS stderrTail,proposal_id AS proposalId,batch_ref AS batchRef
       FROM connector_runs ORDER BY id`,
      )
      .all<ConnectorRunRecord>(),
    vaults: conversion.genesis.vaults.map((vault) => ({
      vault: vault.vault,
      notifications: notifications.history(vault.vault),
      connectorFetch: notifications.connectorFetch(vault.vault),
    })),
  };
}

function expectedOf(
  conversion: StrictConversion,
  mappings: ReturnType<typeof sourceMappings>,
  calendar: Uint8Array | null,
): unknown {
  const notifications = (
    rows: (typeof conversion.genesis.vaults)[number]["deviceLocal"]["notifications"],
  ) => [...rows].sort((a, b) => compare(a.signal, b.signal) || compare(a.severity, b.severity));
  const connectorFetch = (
    rows: (typeof conversion.genesis.vaults)[number]["deviceLocal"]["connectorFetch"],
  ) => [...rows].sort((a, b) => compare(a.binding, b.binding));
  return {
    cache: conversion.cacheReceipt.receipt,
    calendar: encoded(calendar),
    overlays: { bars: [], masks: [] },
    mappings: { identities: mappings.identities, aliases: mappings.aliases },
    globalCatalog: mappings.globalCatalog,
    mcpCalls: sourceMcpCalls(conversion),
    connectorRuns: sourceConnectorRuns(conversion),
    vaults: conversion.genesis.vaults.map((vault) => ({
      vault: vault.vault,
      notifications: notifications(vault.deviceLocal.notifications),
      connectorFetch: connectorFetch(vault.deviceLocal.connectorFetch),
    })),
  };
}

function proofOf(
  conversion: StrictConversion,
  digest: string,
  calendar: Uint8Array | null,
): LocalStateProof {
  return {
    format: 1,
    digest,
    priceBars: conversion.cacheReceipt.priceBars,
    fxRates: conversion.cacheReceipt.fxRates,
    macroBars: conversion.cacheReceipt.macroBars,
    calendarBytes: calendar?.length ?? 0,
    calendarSha256: calendar === null ? null : createHash("sha256").update(calendar).digest("hex"),
    mcpCalls: sourceMcpCalls(conversion).length,
    connectorRuns: sourceConnectorRuns(conversion).length,
    globalInstruments: sourceMappings(conversion).globalCatalog.filter(
      (row) => row.kind === "instrument",
    ).length,
    globalAliases: sourceMappings(conversion).globalCatalog.filter((row) => row.kind === "alias")
      .length,
    notifications: conversion.genesis.vaults.reduce(
      (sum, vault) => sum + vault.deviceLocal.notifications.length,
      0,
    ),
    connectorFetch: conversion.genesis.vaults.reduce(
      (sum, vault) => sum + vault.deviceLocal.connectorFetch.length,
      0,
    ),
  };
}

/** Write exact verified source-local state into the fresh device database before inventory. */
export function hydrateLocalState(
  driver: SqlDriver,
  conversion: StrictConversion,
): LocalStateProof {
  try {
    const mappings = sourceMappings(conversion);
    const calendar = sourceCalendarBytes(conversion);
    const expected = expectedOf(conversion, mappings, calendar);
    const cache = new SqlPriceCache(driver);
    const notifications = new NotificationQueue(driver);
    const calendarCache = new SqlCalendarCache(driver);
    const globalCatalog = new SqlGlobalCatalog(driver);
    const mcpCalls = sourceMcpCalls(conversion);
    const connectorRuns = sourceConnectorRuns(conversion);
    ensureConnectorRunHistory(driver);
    driver.transaction(() => {
      if (calendar) calendarCache.restoreBytes(calendar);
      cache.restoreSourceCache(
        conversion.cacheReceipt.receipt,
        mappings.identities,
        mappings.aliases,
      );
      globalCatalog.restore(mappings.globalCatalog);
      for (const vault of conversion.genesis.vaults) {
        notifications.restoreHistory(vault.vault, vault.deviceLocal.notifications);
        notifications.restoreConnectorFetch(vault.vault, vault.deviceLocal.connectorFetch);
      }
      const insert = driver.prepare(
        `INSERT INTO mcp_calls(id,vault,tool,privacy,called_at,args,outcome,error_kind,duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const row of mcpCalls) {
        insert.run(
          row.id,
          row.vault,
          row.tool,
          row.privacy,
          row.calledAt,
          row.args,
          row.outcome,
          row.errorKind,
          row.durationMs,
        );
      }
      restoreConnectorRuns(driver, connectorRuns);
      if (sha(stateOf(driver, conversion)) !== sha(expected)) {
        throw new MigrationError("replay_mismatch");
      }
    });
    return proofOf(conversion, sha(expected), calendar);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("replay_mismatch");
  }
}

/** Independent reopen read: exact row content, identities and per-vault history must still match. */
export function verifyHydratedLocalState(
  driver: SqlDriver,
  conversion: StrictConversion,
  expectedProof?: LocalStateProof,
): void {
  try {
    const mappings = sourceMappings(conversion);
    const calendar = sourceCalendarBytes(conversion);
    const digest = sha(stateOf(driver, conversion));
    const expected = proofOf(conversion, sha(expectedOf(conversion, mappings, calendar)), calendar);
    if (
      digest !== expected.digest ||
      (expectedProof && canonicalJson(expected) !== canonicalJson(expectedProof))
    ) {
      throw new MigrationError("replay_mismatch");
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("replay_mismatch");
  }
}
