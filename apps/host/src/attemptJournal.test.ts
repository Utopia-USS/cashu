import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqlAttemptJournal } from "./attemptJournal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-attempt-test-"));
  roots.push(dir);
  return join(dir, "private.db");
}

describe("SqlAttemptJournal", () => {
  it("keeps a may-append key and original EIDs across restart", async () => {
    const path = fixture();
    const driver = openNodeSqlite(path);
    const journal = SqlAttemptJournal.open(driver, "new");
    const record = {
      vault: "a".repeat(32),
      key: "key-1",
      attemptId: "attempt-1",
      commandId: "core.renameProfile",
      fingerprint: "f".repeat(64),
      eids: ["e".repeat(26)],
      digest: "d".repeat(64),
    };
    expect(await journal.saveMayAppend(record)).toMatchObject({
      phase: "may_append",
      attemptId: record.attemptId,
      eids: record.eids,
      digest: record.digest,
    });
    driver.close();
    const reopened = openNodeSqlite(path);
    const again = SqlAttemptJournal.open(reopened, "existing");
    expect(again.status(record.vault, record.key, record.commandId)).toMatchObject({
      phase: "may_append",
      eids: record.eids,
      digest: record.digest,
    });
    expect(await again.unresolved(record.vault)).toEqual([record]);
    expect(await again.saveMayAppend({ ...record, eids: ["x"] })).toMatchObject({
      phase: "may_append",
      eids: record.eids,
      digest: record.digest,
    });
    expect(() => again.status("b".repeat(32), record.key, record.commandId)).toThrow(
      "request_key_conflict",
    );
    expect(() => again.status(record.vault, record.key, "other")).toThrow("request_key_conflict");
    reopened.close();
  });

  it("expires only a completed response, retaining the key and EIDs", async () => {
    const path = fixture();
    const driver = openNodeSqlite(path);
    let now = 100;
    const journal = SqlAttemptJournal.open(driver, "new", () => now);
    const record = {
      vault: "a".repeat(32),
      key: "key-2",
      attemptId: "attempt-2",
      commandId: "core.renameProfile",
      fingerprint: "f".repeat(64),
      eids: ["e".repeat(26)],
      digest: "d".repeat(64),
    };
    await journal.saveMayAppend(record);
    await journal.markCompleted(record.attemptId, { changed: true });
    expect(journal.status(record.vault, record.key, record.commandId)).toMatchObject({
      phase: "completed",
      receipt: { value: { changed: true } },
    });
    now += 24 * 60 * 60 * 1000 + 1;
    expect(journal.pruneReceipts()).toBe(1);
    expect(journal.status(record.vault, record.key, record.commandId)).toMatchObject({
      phase: "completed",
      eids: record.eids,
    });
    expect(journal.status(record.vault, record.key, record.commandId)).toHaveProperty(
      "receipt",
      undefined,
    );
    driver.close();
  });
});
