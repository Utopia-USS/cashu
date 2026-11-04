import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { finishMcpCall, startMcpCall } from "../../device/audit.js";
import { devicePreferences, setDevicePreferences } from "../../device/settings.js";
import { DeviceStore } from "../../device/store.js";
import { betterSqlite3Driver } from "../../sql/better-sqlite3.js";
import { run, testEnv } from "../../testing/commands.js";
import { openTestStore } from "../../testing/store.js";
import { createProfile, setModules } from "../commands.js";
import { mcpAudit, saveProfile, toggledModules } from "./index.js";

describe("desktop Settings owner actions", () => {
  it("saves trimmed name and normalized currency in one batch, reads back, then emits no-op", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(run(store, env, createProfile, { slug: "dom", name: "Home" }).ok).toBe(true);
    const changed = run(store, env, saveProfile, { name: "  Household  ", baseCurrency: "eur" });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.events.map((event) => event.type)).toEqual([
      "profile.renamed",
      "profile.settingsChanged",
    ]);
    expect(store.read("SELECT name, base_currency AS currency FROM profiles")).toEqual([
      { name: "Household", currency: "EUR" },
    ]);
    expect(run(store, env, saveProfile, { name: "Household", baseCurrency: "EUR" })).toMatchObject({
      ok: true,
      events: [],
    });
    expect(run(store, env, saveProfile, { name: " ", baseCurrency: "USD" })).toMatchObject({
      ok: false,
      reason: "invalid_name",
    });
    expect(store.read("SELECT name, base_currency AS currency FROM profiles")).toEqual([
      { name: "Household", currency: "EUR" },
    ]);
  });

  it("uses registered dependency closure and disabling keeps module data", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(run(store, env, createProfile, { slug: "home", name: "Home" }).ok).toBe(true);
    const enabled = toggledModules([], "loans");
    expect(enabled).not.toBeNull();
    expect(run(store, env, setModules, { moduleIds: enabled ?? [] }).ok).toBe(true);
    const disabled = toggledModules(enabled ?? [], "loans");
    expect(disabled).toEqual([]);
    expect(run(store, env, setModules, { moduleIds: disabled ?? [] }).ok).toBe(true);
    expect(
      store.read("SELECT module_id, enabled FROM profile_modules WHERE module_id = 'loans'"),
    ).toEqual([{ module_id: "loans", enabled: 0 }]);
  });

  it("reads device preferences back and isolates audit keys/types by exact vault and owner privacy", () => {
    const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
    const read = device.read.bind(device);
    const vault = "5f0c3a9e81d24b7690ae13c7d2f4b856";
    const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(device.run(setDevicePreferences, { theme: "dark", languagePin: "pl" }).ok).toBe(true);
    expect(devicePreferences.run(read, undefined)).toMatchObject({
      theme: "dark",
      languagePin: "pl",
    });
    const created = device.run(startMcpCall, {
      vault,
      tool: "synthetic_tool",
      calledAt: "2026-11-03T08:00:00.000Z",
      args: { scope: "string", _unknown: 2 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      device.run(finishMcpCall, {
        id: created.value.id,
        vault,
        privacy: "strict",
        outcome: "ok",
        durationMs: 17,
      }).ok,
    ).toBe(true);
    const own = mcpAudit.run(read, { vault, since: "2026-11-01T00:00:00.000Z", privacy: false });
    expect(own).toMatchObject({
      hidden: false,
      count7d: 1,
      calls: [
        {
          tool: "synthetic_tool",
          arguments: [{ name: "scope", type: "string" }],
          unknownArgumentCount: 2,
        },
      ],
    });
    expect(JSON.stringify(own)).not.toContain("private-value");
    expect(
      mcpAudit.run(read, { vault: other, since: "2026-11-01T00:00:00.000Z", privacy: false }),
    ).toMatchObject({ hidden: false, count7d: 0, calls: [] });
    expect(
      mcpAudit.run(read, { vault, since: "2026-11-01T00:00:00.000Z", privacy: true }),
    ).toMatchObject({ hidden: true, count7d: 0, calls: [] });
    device.close();
  });

  it("shows a malformed old audit row without argument names", () => {
    const db = new Database(":memory:");
    const device = DeviceStore.open(betterSqlite3Driver(db));
    const vault = "5f0c3a9e81d24b7690ae13c7d2f4b856";
    const created = device.run(startMcpCall, {
      vault,
      tool: "synthetic_tool",
      calledAt: "2026-11-03T08:00:00.000Z",
      args: { scope: "string" },
    });
    expect(created.ok).toBe(true);
    db.prepare("UPDATE mcp_calls SET args = ?").run("{not json");
    const audit = mcpAudit.run(device.read.bind(device), {
      vault,
      since: "2026-11-01T00:00:00.000Z",
      privacy: false,
    });
    expect(audit).toMatchObject({
      hidden: false,
      calls: [{ tool: "synthetic_tool", arguments: [], unknownArgumentCount: 0 }],
    });
    device.close();
  });
});
