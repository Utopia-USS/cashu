import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ConnectorCatalog } from "../connectors/catalog.js";
import { ConnectorProposalReceipts, connectorRequestHash } from "./connectorReceipt.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reopens an intent after a lost response and reconciles only matching pending content", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-proposal-receipt-"));
  roots.push(root);
  mkdirSync(`${root}/data`, { mode: 0o700 });
  const receipts = new ConnectorProposalReceipts(`${root}/data`);
  const key = "01K9B2W000000000000000000C";
  const vault = "a".repeat(32);
  const contentSha256 = "b".repeat(64);
  const row = {
    key,
    vault,
    requestHash: connectorRequestHash({ catalogId: "sample" }),
    id: "sample-file",
    contentSha256,
    replaced: false,
  };
  receipts.begin(row);
  const reopened = new ConnectorProposalReceipts(`${root}/data`);
  let approval: string = "pending";
  let digest = "c".repeat(64);
  const catalog = {
    list: () => [{ id: row.id, approval, contentSha256: digest }],
    installed: () => ({ contentSha256: digest, manifest: { module: "budget", kind: "file" } }),
  } as unknown as ConnectorCatalog;
  expect(reopened.status(key, vault, catalog)).toBe("outcome_unknown");
  digest = contentSha256;
  expect(reopened.status(key, vault, catalog)).toBe("completed");
  expect(new ConnectorProposalReceipts(`${root}/data`).status(key, vault, catalog)).toBe(
    "completed",
  );
  approval = "disabled";
  expect(reopened.status(key, vault, catalog)).toBe("completed");
  expect(reopened.lookup(key, vault)).toMatchObject({
    phase: "completed",
    result: { status: "pending", contentSha256 },
  });
  digest = "e".repeat(64);
  expect(reopened.status(key, vault, catalog)).toBe("completed");
  const otherVault = "d".repeat(32);
  expect(reopened.lookup(key, otherVault)).toBeNull();
  reopened.begin({ ...row, vault: otherVault });
  expect(reopened.lookup(key, otherVault)).toMatchObject({ phase: "intent", vault: otherVault });
  const secretReceipt = reopened.begin({ ...row, key: "fetch-secret", id: "sample-fetch" });
  reopened.complete(secretReceipt, {
    id: "sample-fetch",
    status: "pending",
    replaced: false,
    contentSha256,
    module: "budget",
    kind: "fetch",
    hosts: ["example.invalid"],
    secretIds: ["api_key"],
  });
  expect(reopened.lookup("fetch-secret", vault)).toMatchObject({
    phase: "completed",
    result: { secretIds: ["api_key"] },
  });
  expect(() =>
    reopened.begin({ ...row, requestHash: connectorRequestHash({ catalogId: "different" }) }),
  ).toThrow("request_key_conflict");
});
