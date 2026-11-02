import { readFileSync } from "node:fs";
import { investments as inv } from "@cashu/domain";
import { afterEach, expect, it } from "vitest";
import { withPythonDb } from "../../sources/pythonDb.ts";
import { type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { produceAlerts } from "./alerts.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/alerts-view.json", import.meta.url), "utf8"),
) as { sql: string; expected: unknown };
let ds: SyntheticDataset | undefined;
afterEach(() => ds?.dispose());

it("preserves real tags on the current schema and mirrors the migration NULL default on old copies", () => {
  ds = syntheticDataset(fixture.sql);
  const read = () =>
    withPythonDb({ dataset: "demo", sourceDir: ds?.dir, runRoot: ds?.runRoot }, (db) => ({
      rows: db.investments.storedAlerts(1),
      other: db.investments.storedAlerts(2),
      output: JSON.parse(dumps(produceAlerts(db))) as Record<string, unknown>,
    }));
  const current = read();
  expect(current.rows.find((r) => r.id === 1)?.tag).toBe("cena");
  expect(current.rows).toHaveLength(11);
  expect(current.other.map((r) => r.id)).toEqual([12]);
  ds.exec("ALTER TABLE alerts DROP COLUMN tag");
  const legacy = read();
  expect(legacy.rows).toEqual(current.rows.map((r) => ({ ...r, tag: null })));
  expect(legacy.other).toEqual(current.other.map((r) => ({ ...r, tag: null })));
  const expected = Object.fromEntries(
    Object.entries(current.output).map(([key, value]) => {
      if (key === "alert_kinds") return [key, value];
      const profile = value as { readonly alerts: readonly Record<string, unknown>[] };
      return [key, { ...profile, alerts: profile.alerts.map((a) => ({ ...a, tag: null })) }];
    }),
  );
  expect(legacy.output).toEqual(expected);
});

it("matches actual Python alerts_view and the complete catalog with native dynamic states", () => {
  ds = syntheticDataset(fixture.sql);
  withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
    expect(JSON.parse(dumps(produceAlerts(db)))).toEqual(fixture.expected);
    const rows = db.investments.storedAlerts(1);
    expect(rows).toHaveLength(11);
    expect(db.investments.storedAlerts(2).map((r) => r.id)).toEqual([12]);
    expect(rows.some((r) => r.id === 13)).toBe(false);
    expect(rows.find((r) => r.id === 1)?.tag).toBe("cena");
    expect(rows.find((r) => r.id === 3)?.params.window_days).toBe(5n);
  });
});

it("keeps legacy raw-status parity separate from effective production clock reads", () => {
  ds = syntheticDataset(fixture.sql);
  withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
    const row = db.investments.storedAlerts(1).find((r) => r.id === 5);
    expect(row?.status).toBe("active");
    expect(
      inv.alerts.effectiveAlertStatus(
        { status: "active", expires_at: row?.expiresAt ?? null, snoozed_until: null },
        "2026-10-01T10:00:00Z",
      ).status,
    ).toBe("expired");
  });
});

it("recomputes dynamic state from copied native bars instead of replaying Python view results", () => {
  ds = syntheticDataset(fixture.sql);
  const run = () =>
    withPythonDb({ dataset: "demo", sourceDir: ds?.dir, runRoot: ds?.runRoot }, (db) =>
      JSON.parse(dumps(produceAlerts(db))),
    );
  const before = run();
  ds.exec("UPDATE inv_price_bars SET close = '100' WHERE date = '2026-10-01'");
  expect(run()).not.toEqual(before);
});

it("maps canonical and leading-zero legacy open-alert links to the same alert", () => {
  ds = syntheticDataset(fixture.sql);
  const run = () =>
    withPythonDb({ dataset: "demo", sourceDir: ds?.dir, runRoot: ds?.runRoot }, (db) => ({
      signal: JSON.parse(dumps(produceAlerts(db)))[db.keys.key("profiles", 1)].alerts[0].signal,
      key: db.keys.key("inv_signals", 1),
    }));
  const before = run();
  ds.exec("UPDATE inv_signals SET dedup_key = 'alert:0001' WHERE id = 1");
  const after = run();
  expect(after.signal).toEqual({ ...before.signal, id: after.key });
  // Natural keys include the stored dedup key, so the same row's canonical key changes here.
  expect(after.signal.id).not.toBe(before.signal.id);
});
