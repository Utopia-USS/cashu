// admin.status stays additive: the S56c sync field is optional, and an older client's schema (which
// does not know it) still parses a newer host's status.
import { describe, expect, it } from "vitest";
import { adminStatusResultSchema, syncStatusSchema } from "./admin.js";

const base = {
  pid: 42,
  build: "dev",
  protocol: { major: 1, minor: 2 },
  startedAt: "2026-03-01T10:00:00.000Z",
  dataDir: "a".repeat(64),
  sessions: { ui: 0, mcp: 0, cli: 0, admin: 1 },
  stopping: false,
};

describe("admin.status sync field", () => {
  it("is optional", () => {
    expect(adminStatusResultSchema.parse(base).sync).toBeUndefined();
  });

  it("carries per-vault state by ordinal", () => {
    const sync = {
      state: "idle",
      pending: 0,
      lastRunAt: "2026-03-01T10:00:01.000Z",
      vaults: [{ ordinal: 0, leader: true, intentOpen: false, pipeSeq: 12 }],
    };
    expect(adminStatusResultSchema.parse({ ...base, sync }).sync).toEqual(sync);
  });

  it("refuses an unknown state", () => {
    expect(syncStatusSchema.safeParse({ state: "weird", vaults: [] }).success).toBe(false);
  });

  it("is ignored by a schema that predates it", () => {
    const old = adminStatusResultSchema.omit({ sync: true });
    expect(old.parse({ ...base, sync: { state: "idle", vaults: [] } })).toEqual(base);
  });
});
