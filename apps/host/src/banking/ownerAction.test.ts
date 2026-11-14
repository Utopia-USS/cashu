import { generateKeyPairSync } from "node:crypto";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import type { OpenVault } from "../stores.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { runBankingOwnerAction } from "./ownerAction.js";
import { BankingRuntime } from "./runtime.js";

afterEach(cleanup);

it("uses the native private-file boundary and returns only sanitized owner outcomes", async () => {
  const dataDir = tempDir();
  const host = await startLocalHost({ ...testHostOptions(dataDir) });
  const opened = [...host.stores.vaults.values()][0];
  if (!opened) throw new Error("synthetic profile missing");
  (host.stores.vaults as Map<string, OpenVault>).set(opened.id, {
    ...opened,
    mode: "native",
    native: {
      isCurrent: () => true,
      canRunSideEffects: () => true,
      canFetchPublicMarket: () => true,
      attempts: { unresolved: async () => [] },
    },
  } as unknown as OpenVault);
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const keyPath = join(dataDir, "synthetic-key.pem");
  writeFileSync(keyPath, key, { mode: 0o600 });
  const alias = join(dataDir, "synthetic-link.pem");
  symlinkSync(keyPath, alias);
  const values = new Map<string, string>();
  let owner = true;
  const runtime = new BankingRuntime({
    dataDir,
    lock: host.lease.lock(),
    stores: host.stores,
    redirectUrl: "https://127.0.0.1:18888/eb/callback",
    language: () => "pl",
    isOwnerAction: () => owner,
    makeSecrets: (authority) => ({
      namespace: `synthetic:${authority.profileId}`,
      async get(kind) {
        return values.get(kind) ?? null;
      },
      async set(kind, value) {
        values.set(kind, value);
      },
      async clear(kind) {
        values.delete(kind);
      },
    }),
  });
  try {
    const profileId = [...host.stores.vaults.keys()][0];
    if (!profileId) throw new Error("synthetic profile missing");
    const action = (value: unknown) =>
      runBankingOwnerAction({ runtime, profileId, isOwnerAction: () => owner, action: value });
    expect(await action({ type: "unknown" })).toEqual({
      ok: false,
      error: "unknown_or_invalid_action",
    });
    expect(await action({ type: "configure", appId: "synthetic-app", keyFilePath: alias })).toEqual(
      { ok: false, error: "key_unreadable" },
    );
    const notKey = join(dataDir, "synthetic-not-a-key.pem");
    writeFileSync(notKey, "synthetic, not a key\n", { mode: 0o600 });
    expect(
      await action({ type: "configure", appId: "synthetic-app", keyFilePath: notKey }),
    ).toEqual({ ok: false, error: "key_invalid" });
    const small = join(dataDir, "synthetic-small.pem");
    writeFileSync(
      small,
      generateKeyPairSync("rsa", { modulusLength: 1024 })
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
    );
    expect(await action({ type: "configure", appId: "synthetic-app", keyFilePath: small })).toEqual(
      { ok: false, error: "key_invalid" },
    );
    // A browser download (0644), the way Enable Banking's Control Panel hands the key over.
    chmodSync(keyPath, 0o644);
    const result = await action({
      type: "configure",
      appId: "synthetic-app",
      keyFilePath: keyPath,
    });
    expect(result).toEqual({ ok: true, value: { configured: true } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(await action({ type: "status" })).toMatchObject({
      ok: true,
      value: { configured: true, application: "synthetic-app" },
    });
    // Removing the configuration clears the key and every connection; the vault keeps its data.
    expect(await action({ type: "unconfigure" })).toEqual({ ok: true, value: { removed: true } });
    expect(values.has("credentials")).toBe(false);
    expect(values.has("sessions")).toBe(false);
    expect(await action({ type: "status" })).toMatchObject({
      ok: true,
      value: { configured: false, application: null, sessions: [] },
    });
    owner = false;
    expect(await action({ type: "status" })).toEqual({ ok: false, error: "authorization" });
  } finally {
    await runtime.close();
    (host.stores.vaults as Map<string, OpenVault>).set(opened.id, opened);
    await host.stop();
  }
});
