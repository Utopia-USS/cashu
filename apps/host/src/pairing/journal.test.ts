import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { afterEach, expect, it } from "vitest";
import { type PairingAttempt, PairingJournal } from "./journal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function path(): string {
  const root = mkdtempSync(join(tmpdir(), "cashu-pairing-journal-"));
  roots.push(root);
  return join(root, "private.db");
}

function attempt(vault = "a".repeat(32)): PairingAttempt {
  return {
    session: "1".repeat(32),
    operationId: "01K9C000000000000000000000",
    vault,
    device: "2".repeat(32),
    signKey: "3".repeat(64),
    boxKey: "4".repeat(64),
    certificate: "aa",
    event: { v: 1, t: "device.added", i: "01K9C000000000000000000001", d: {} },
    eid: "01K9C000000000000000000001",
    digest: "5".repeat(64),
    welcome: Uint8Array.from([1, 2, 3]),
    pages: [Uint8Array.from([4, 5])],
    phase: "may_append",
  };
}

it("isolates every lookup and transition by vault and refuses exact-subject conflicts", () => {
  const driver = openNodeSqlite(path());
  try {
    const journal = new PairingJournal(driver);
    const prepared = attempt();
    journal.prepare(prepared);
    expect(journal.get(prepared.vault, prepared.session)?.device).toBe(prepared.device);
    expect(journal.get("b".repeat(32), prepared.session)).toBeUndefined();
    expect(journal.forOperation("b".repeat(32), prepared.operationId)).toBeUndefined();
    expect(journal.forDevice("b".repeat(32), prepared.device)).toBeUndefined();
    expect(() => journal.mark("b".repeat(32), prepared.session, "completed", 100)).toThrow(
      "pairing_attempt_changed",
    );
    for (const changed of [
      { ...prepared, signKey: "6".repeat(64) },
      { ...prepared, certificate: "bb" },
      { ...prepared, event: { ...prepared.event, d: { changed: true } } },
      { ...prepared, welcome: Uint8Array.from([9]) },
    ])
      expect(() => journal.prepare(changed)).toThrow("pairing_attempt_conflict");
    expect(() => journal.prepare(attempt("b".repeat(32)))).toThrow("pairing_attempt_conflict");
  } finally {
    driver.close();
  }
});

it("expires only sealed welcome bytes and retains cold terminal proof", () => {
  const filename = path();
  const driver = openNodeSqlite(filename);
  const prepared = attempt();
  const journal = new PairingJournal(driver);
  journal.prepare(prepared);
  journal.mark(prepared.vault, prepared.session, "completed", 100);
  expect(journal.pruneReceipts(prepared.vault, 100 + 24 * 60 * 60 * 1000 + 1)).toBe(1);
  driver.close();
  const reopened = openNodeSqlite(filename);
  try {
    const cold = new PairingJournal(reopened).get(prepared.vault, prepared.session);
    expect(cold).toMatchObject({
      phase: "completed",
      device: prepared.device,
      eid: prepared.eid,
      digest: prepared.digest,
      committedAt: 100,
    });
    expect(cold?.welcome).toHaveLength(0);
    expect(cold?.pages).toHaveLength(0);
  } finally {
    reopened.close();
  }
});

it("persists the exact QR expiry and decrypted hello subject before challenge", () => {
  const filename = path();
  const driver = openNodeSqlite(filename);
  const record = {
    session: "7".repeat(32),
    operationId: "01K9C000000000000000000007",
    vault: "a".repeat(32),
    qrDigest: "8".repeat(64),
    expiresAt: 1_800_000_000_000,
  };
  const journal = new PairingJournal(driver);
  journal.registerInvite(record);
  journal.bindJoiner(record.vault, record.session, {
    device: "2".repeat(32),
    signKey: "3".repeat(64),
    boxKey: "4".repeat(64),
  });
  expect(journal.invite("b".repeat(32), record.session)).toBeUndefined();
  expect(() => journal.registerInvite({ ...record, qrDigest: "9".repeat(64) })).toThrow(
    "pairing_invite_conflict",
  );
  expect(() =>
    journal.bindJoiner(record.vault, record.session, {
      device: "2".repeat(32),
      signKey: "5".repeat(64),
      boxKey: "4".repeat(64),
    }),
  ).toThrow("pairing_invite_conflict");
  driver.close();
  const reopened = openNodeSqlite(filename);
  try {
    const cold = new PairingJournal(reopened);
    expect(cold.invite(record.vault, record.session)).toMatchObject({
      ...record,
      device: "2".repeat(32),
      signKey: "3".repeat(64),
      boxKey: "4".repeat(64),
    });
    expect(cold.pruneInvites(record.vault, record.expiresAt + 24 * 60 * 60 * 1000 + 1)).toBe(1);
    expect(cold.invite(record.vault, record.session)).toBeUndefined();
  } finally {
    reopened.close();
  }
});
