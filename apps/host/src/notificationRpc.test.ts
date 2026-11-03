import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_CREATION_FEATURE,
  NOTIFICATION_INTENT_FEATURE,
  NOTIFICATION_INTENT_METHOD,
  nativeCreationCommitResultSchema,
  nativeCreationPrepareResultSchema,
} from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import type { createProductionKeyStore } from "@cashu/node-host/keyring";
import { createTestKeyStore, type OsKeyringPort } from "@cashu/node-host/testing";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { privateNotificationIntents } from "./notifications/intentLedger.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { cleanup, tempDir } from "./testing/harness.js";

const roots: string[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("resolves the exact genuinely created native vault after host restart and consumes once", async () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "t44-test-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const items = new Map<string, Uint8Array>();
  const keyring: OsKeyringPort = {
    async get(service, account) {
      return items.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      items.set(`${service}/${account}`, value.slice());
    },
  };
  const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
  const createKeyStore: typeof createProductionKeyStore = (input) =>
    createTestKeyStore({ ...input, service, keyring });
  const options = () => ({
    dataDir,
    home: tempDir(),
    vaultSource: {
      kind: "native-production" as const,
      factory: new ProductionVaultSourceFactory(dataDir, createKeyStore),
    },
    launcher: false,
    python: null,
  });
  const setup = await startLocalHost(options());
  const creator = await connectHost({ dataDir, role: "ui", build: "notification-create-test" });
  let vaultId: string;
  try {
    expect(creator.host.features).toContain(NATIVE_CREATION_FEATURE);
    const prepared = nativeCreationPrepareResultSchema.parse(
      await creator.call("native.creation.prepare", {
        name: "Synthetic",
        slug: "synthetic",
        baseCurrency: "PLN",
        modules: [],
        mcpPrivacy: "strict",
      }),
    );
    if (prepared.kind !== "prepared") throw new Error("synthetic prepare refused");
    const committed = nativeCreationCommitResultSchema.parse(
      await creator.call("native.creation.commit", {
        operationId: prepared.operationId,
        phraseSession: prepared.phraseSession,
      }),
    );
    if (committed.kind !== "ready")
      throw new Error(
        `synthetic Create ${committed.kind}${"stage" in committed ? `:${committed.stage}` : ""}`,
      );
    vaultId = committed.vaultId;
  } finally {
    creator.close();
    await setup.stop();
  }

  const opened = await startLocalHost(options());
  const ledger = privateNotificationIntents(dataDir, () => true, Date.now);
  const valid = ledger.reserve({ vaultId, kind: "signalsSummary", locale: "pl" });
  const wrong = ledger.reserve({ vaultId: "f".repeat(32), kind: "generic", locale: "en" });
  await opened.stop();

  const restarted = await startLocalHost(options());
  const ui = await connectHost({ dataDir, role: "ui", build: "notification-rpc-test" });
  try {
    expect(restarted.stores.vaults.has(vaultId)).toBe(true);
    expect(ui.host.features).toContain(NOTIFICATION_INTENT_FEATURE);
    const call = (requestId: string, intentToken: string) =>
      ui.call(NOTIFICATION_INTENT_METHOD, { requestId, intentToken });
    expect(await call(wrong.requestId, wrong.intentToken)).toEqual({ kind: "unavailable" });
    expect(await call(valid.requestId, valid.intentToken)).toEqual({
      kind: "target",
      vaultId,
      target: "signalsSummary",
    });
    expect(await call(valid.requestId, valid.intentToken)).toEqual({ kind: "unavailable" });
    const stale = ledger.reserve({ vaultId, kind: "generic", locale: "en" });
    restarted.stores.invalidate();
    expect(await call(stale.requestId, stale.intentToken)).toEqual({ kind: "unavailable" });
  } finally {
    ui.close();
    await restarted.stop();
  }
});

it("resolves persisted locators after native host restart but never opens an absent vault", async () => {
  const dataDir = tempDir();
  const options = () => ({
    dataDir,
    home: tempDir(),
    vaultSource: {
      kind: "native-production" as const,
      factory: new ProductionVaultSourceFactory(dataDir),
    },
    launcher: false,
    python: null,
  });
  const first = await startLocalHost(options());
  const ledger = privateNotificationIntents(dataDir, () => true, Date.now);
  const intent = ledger.reserve({ vaultId: "absent-native-vault", kind: "generic", locale: "en" });
  await first.stop();

  const second = await startLocalHost(options());
  const ui = await connectHost({ dataDir, role: "ui", build: "notification-rpc-test" });
  try {
    expect(second.server.lock.held).toBe(true);
    expect(ui.host.features).toContain(NOTIFICATION_INTENT_FEATURE);
    expect(
      await ui.call(NOTIFICATION_INTENT_METHOD, {
        requestId: intent.requestId,
        intentToken: intent.intentToken,
      }),
    ).toEqual({ kind: "unavailable" });
    expect(ledger.resolve(intent.requestId, intent.intentToken)).toBeNull();
    expect(
      await ui.call(NOTIFICATION_INTENT_METHOD, {
        requestId: intent.requestId,
        intentToken: intent.intentToken,
      }),
    ).toEqual({ kind: "unavailable" });
  } finally {
    ui.close();
    await second.stop();
  }
});
