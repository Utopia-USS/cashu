import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import { finishMcpCall, startMcpCall } from "./audit.js";
import { DeviceStore } from "./store.js";

const vault = "5f0c3a9e81d24b7690ae13c7d2f4b856";
it("persists a started audit before work and updates only the matching vault call", () => {
  const store = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  const result = store.run(startMcpCall, {
    vault,
    tool: "setup_status",
    calledAt: "2026-11-01T12:00:00.000Z",
    args: { module: "string", _unknown: 1 },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("audit start refused");
  expect(store.read("SELECT outcome, args FROM mcp_calls")).toEqual([
    { outcome: "started", args: '{"module":"string","_unknown":1}' },
  ]);
  expect(
    store.run(finishMcpCall, {
      id: result.value.id,
      vault: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      privacy: "strict",
      outcome: "ok",
      durationMs: 2,
    }),
  ).toEqual({ ok: false, reason: "no_call" });
  expect(
    store.run(finishMcpCall, {
      id: result.value.id,
      vault,
      privacy: "strict",
      outcome: "refused",
      errorKind: "module_disabled",
      durationMs: 2,
    }).ok,
  ).toBe(true);
  expect(store.read("SELECT outcome, privacy, error_kind FROM mcp_calls")).toEqual([
    { outcome: "refused", privacy: "strict", error_kind: "module_disabled" },
  ]);
  store.close();
});
it("refuses argument values and malformed audit metadata", () => {
  const store = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  expect(
    store.run(startMcpCall, {
      vault,
      tool: "setup_status",
      calledAt: "2026-11-01T12:00:00.000Z",
      args: { module: "private-value" },
    }),
  ).toEqual({ ok: false, reason: "invalid_input" });
  expect(
    store.run(startMcpCall, {
      vault,
      tool: "setup_status",
      calledAt: "2026-11-01T12:00:00.000Z",
      args: { amount: 123 },
    }),
  ).toEqual({ ok: false, reason: "invalid_input" });
  expect(store.read("SELECT * FROM mcp_calls")).toEqual([]);
  store.close();
});
