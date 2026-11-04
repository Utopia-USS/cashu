import type { StoreToClient } from "@cashu/host-protocol/store";
import type { ClassifierSecretStore } from "@cashu/node-host/classifier-secrets";
import type { ClassifierSettingsInput } from "@cashu/store/core/classifier-settings";
import { expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { storeClient } from "../testing/harness.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { ClassifierHostPorts } from "./hostPorts.js";

it("binds production classifier consent through a native host owner action", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  const ports = new ClassifierHostPorts();
  let key: string | null = null;
  let fetches = 0;
  const secrets: ClassifierSecretStore = {
    get: async () => key,
    set: async (value) => {
      key = value;
    },
    clear: async () => {
      key = null;
    },
  };
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    budgetClassifiers: { local: ports.local, cloud: ports.cloud },
    uiActions: [ports.action],
    worker: (context, _notifications, _queue, lock) => {
      if (!lock?.held) throw new Error("synthetic lock unavailable");
      ports.bind({
        dataDir: fixture.dataDir,
        lock,
        stores: context.stores,
        isCurrentVault: context.isCurrent,
        makeSecrets: () => secrets,
        fetch: async () => {
          fetches++;
          throw new Error("network forbidden");
        },
      });
      return undefined;
    },
  });
  const client = await storeClient(fixture.dataDir);
  let rid = 0;
  const action = async (input: ClassifierSettingsInput): Promise<StoreToClient> => {
    const request = ++rid;
    const response = new Promise<StoreToClient>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("classifier action response missing")),
        1500,
      );
      client.conn.onFrame((frame) => {
        if (frame.t !== "store") return;
        const message = frame.m as StoreToClient;
        if (message.t === "actionResult" && message.rid === request) {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    client.conn.send({
      t: "store",
      m: {
        t: "action",
        rid: request,
        target: { kind: "vault", vault: fixture.vaultId },
        action: ports.action.id,
        input,
      },
    });
    return response;
  };
  try {
    expect(await action({ op: "status" })).toMatchObject({
      result: { status: "completed", value: { backend: "ollama", keyPresent: false } },
    });
    expect(ports.cloud.consent(fixture.vaultId)).toBeNull();
    expect(await action({ op: "setKey", key: "synthetic-secret" })).toMatchObject({
      result: { status: "completed" },
    });
    expect(
      await action({
        op: "grantCloud",
        riskCopy: "merchant-name-residual-v1",
        model: "claude-haiku-4-5",
      }),
    ).toMatchObject({
      result: { status: "completed", value: { backend: "anthropic", consented: true } },
    });
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native") throw new Error("synthetic native vault unavailable");
    await vault.native.sync();
    expect(ports.cloud.consent(fixture.vaultId)?.isCurrent(fixture.vaultId)).toBe(true);
    expect(await action({ op: "revokeCloud" })).toMatchObject({
      result: { status: "completed", value: { backend: "ollama", consented: false } },
    });
    expect(ports.cloud.consent(fixture.vaultId)).toBeNull();
    expect(fetches).toBe(0);
  } finally {
    client.close();
    await host.stop();
    fixture.cleanup();
  }
});
