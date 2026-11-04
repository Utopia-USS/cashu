import { describe, expect, it } from "vitest";
import { detGidFor } from "../../gid.js";
import { Store } from "../../materialize.js";
import { builtinModules } from "../../modules.js";
import { memoryDriver } from "../../testing/store.js";
import { genesis } from "../index.js";
import { FILES, KEYS, NOW, seededDb } from "../testing/genesisData.js";
import { compareUtf8, dumps } from "./canonical.js";
import { ROUNDTRIP_COLUMNS } from "./columns.js";
import { GidKeys } from "./keys.js";
import { type GidRow, projectView } from "./project.js";
import {
  projectSourceEntries,
  projectSourceTable,
  SourceProjectionError,
} from "./sourceProject.js";

const keyed = (entries: readonly GidRow[]) =>
  entries
    .map(({ gid, row }) => [gid, row] as const)
    .sort((a, b) => compareUtf8(String(a[0]), String(b[0])));

describe("independent source projection", () => {
  it("projects the 0025 thesis plan timestamp using the reviewed 0026 backfill", () => {
    const source = seededDb("0025");
    try {
      const result = genesis({ driver: source, files: FILES }, KEYS, { strict: true, now: NOW });
      const vault = result.vaults[0];
      if (!vault) throw new Error("synthetic fixture vault missing");
      const key = KEYS.get(vault.slug);
      if (!key) throw new Error("synthetic fixture key missing");
      const store = Store.open({
        driver: memoryDriver(),
        vault: vault.vault,
        salt: key.salt,
        modules: builtinModules(),
      });
      try {
        const def = store.publicTables().find((item) => item.name === "inv_theses");
        if (!def) throw new Error("synthetic fixture view missing");
        const projected = projectSourceEntries(
          source,
          "inv_theses",
          def,
          vault.profileId,
          vault.ids,
          "2026-03-04",
        );
        const rows = source
          .prepare(
            "SELECT id,exit_plan AS exitPlan,updated_at AS updatedAt FROM inv_theses WHERE profile_id=?",
          )
          .all<{ id: number; exitPlan: string | null; updatedAt: string }>(vault.profileId);
        expect(rows.some((row) => row.exitPlan)).toBe(true);
        for (const row of rows) {
          const gid = vault.ids.find(
            (entry) => entry.table === "inv_theses" && entry.localId === String(row.id),
          )?.gid;
          const actual = projected.find((entry) => entry.gid === gid)?.row.exit_plan_changed_at;
          expect(actual).toBe(row.exitPlan ? row.updatedAt.replace(" ", "T") : null);
        }
      } finally {
        store.close();
      }
    } finally {
      source.close();
    }
  });
  it("refuses a source row omitted from both the exported map and event log", () => {
    const source = seededDb("0029");
    try {
      const result = genesis({ driver: source, files: FILES }, KEYS, { strict: true, now: NOW });
      const vault = result.vaults[0];
      if (!vault) throw new Error("synthetic fixture vault missing");
      const missing = vault.ids.find((entry) => entry.table === "accounts");
      if (!missing) throw new Error("synthetic fixture account missing");
      const altered = {
        ...vault,
        ids: vault.ids.filter((entry) => entry !== missing),
        events: vault.events.filter((event) => event.g !== missing.gid),
      };
      const key = KEYS.get(vault.slug);
      if (!key) throw new Error("synthetic fixture key missing");
      const store = Store.open({
        driver: memoryDriver(),
        vault: vault.vault,
        salt: key.salt,
        modules: builtinModules(),
      });
      try {
        const def = store.publicTables().find((item) => item.name === "accounts");
        if (!def) throw new Error("synthetic fixture accounts table missing");
        expect(altered.events.length).toBeLessThan(vault.events.length);
        expect(() =>
          projectSourceTable(source, "accounts", def, vault.profileId, altered.ids, "2026-03-04"),
        ).toThrowError(new SourceProjectionError());
      } finally {
        store.close();
      }
    } finally {
      source.close();
    }
  });

  it("matches every source table of the two-profile synthetic genesis replay", () => {
    const source = seededDb("0029");
    // Keep ordinary rows from every module while removing the known row-level loss cases here.
    // The separate strict accounting gate still refuses any remaining nonzero counter.
    source.exec(`
      UPDATE accounts SET bank='manual' WHERE id=2;
      UPDATE transactions SET counterparty_name='Wypłata gotówki', description='bankomat',
        reference='Wypłata gotówki' WHERE dedup_hash LIKE 'cashleg:%';
      UPDATE transactions SET raw='{}' WHERE raw IS NULL;
      UPDATE transactions SET counterparty_name=description, reference=description,
        raw='{"cash_expense":true}' WHERE dedup_hash LIKE 'cashexp:%';
      UPDATE transactions SET category='other', category_source='default' WHERE account_id=7;
      UPDATE inv_rule_runs SET report='{"new":[],"escalated":[]}';
      UPDATE inv_signals SET status='acknowledged', acknowledged_at=(
        SELECT MIN(d.created_at) FROM inv_decision_signals l
        JOIN inv_decisions d ON d.id=l.decision_id WHERE l.signal_id=inv_signals.id
      ) WHERE id IN (SELECT signal_id FROM inv_decision_signals);
      DELETE FROM proposals WHERE payload LIKE '%"staged"%';
    `);
    const mismatches: string[] = [];
    try {
      const result = genesis({ driver: source, files: FILES }, KEYS, { strict: true, now: NOW });
      for (const vault of result.vaults) {
        const key = KEYS.get(vault.slug);
        if (!key) throw new Error("synthetic fixture key missing");
        const store = Store.open({
          driver: memoryDriver(),
          vault: vault.vault,
          salt: key.salt,
          modules: builtinModules(),
        });
        try {
          for (let index = 0; index < vault.events.length; index += 1000) {
            store.applyWire({
              device: vault.device,
              events: vault.events.slice(index, index + 1000),
            });
          }
          const ids = new Map(
            vault.ids.map((entry) => [`${entry.table}\0${entry.localId}`, entry.gid]),
          );
          const keys = new GidKeys(
            {
              sources: new Map(
                vault.ids.map((entry) => [
                  entry.gid,
                  { table: entry.table, localId: entry.localId },
                ]),
              ),
              det: detGidFor(key.salt),
            },
            {
              key: (table, id) => {
                const gid = ids.get(`${table}\0${id}`);
                if (!gid) throw new Error("synthetic fixture reference missing");
                return gid;
              },
              prefix: (table) => table,
            },
          );
          for (const table of Object.keys(ROUNDTRIP_COLUMNS).sort(compareUtf8)) {
            const def = store.publicTables().find((item) => item.name === table);
            if (!def) throw new Error("synthetic fixture view missing");
            try {
              const expected = projectSourceEntries(
                source,
                table,
                def,
                vault.profileId,
                vault.ids,
                "2026-03-04",
                FILES,
                detGidFor(key.salt),
              );
              if (table === "inv_import_batches" && expected.length > 0) {
                expect(() =>
                  projectSourceEntries(
                    source,
                    table,
                    def,
                    vault.profileId,
                    vault.ids,
                    "2026-03-04",
                    { read: () => new Uint8Array([1]) },
                    detGidFor(key.salt),
                  ),
                ).toThrowError(new SourceProjectionError());
              }
              const actual = projectView(store, table, keys, "2026-03-04");
              if (dumps(keyed(expected)) === dumps(keyed(actual))) continue;
              const sourceByGid = new Map(expected.map((entry) => [entry.gid, entry.row]));
              const actualByGid = new Map(actual.map((entry) => [entry.gid, entry.row]));
              if (sourceByGid.size !== actualByGid.size) {
                mismatches.push(
                  `${table}:count:${expected.length}:${actual.length}:vault${vault.ordinal}`,
                );
                continue;
              }
              for (const gid of new Set([...sourceByGid.keys(), ...actualByGid.keys()])) {
                const a = sourceByGid.get(gid);
                const b = actualByGid.get(gid);
                if (!a || !b) {
                  mismatches.push(`${table}:gid:vault${vault.ordinal}`);
                  continue;
                }
                for (const column of ROUNDTRIP_COLUMNS[table] ?? []) {
                  if (dumps(a[column] ?? null) !== dumps(b[column] ?? null)) {
                    mismatches.push(`${table}.${column}:vault${vault.ordinal}`);
                  }
                }
              }
            } catch (error) {
              mismatches.push(
                `${table}:${error instanceof Error ? error.name : "error"}:vault${vault.ordinal}`,
              );
            }
          }
        } finally {
          store.close();
        }
      }
    } finally {
      source.close();
    }
    expect([...new Set(mismatches)].sort(compareUtf8)).toEqual([]);
  });
});
