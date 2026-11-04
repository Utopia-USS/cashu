import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import type { ClassifierSecretStore } from "@cashu/node-host/classifier-secrets";
import { afterEach, expect, it } from "vitest";
import type { HostStores, OpenVault } from "../stores.js";
import { createProductionClassifierBinding } from "./production.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cashu-classifier-binding-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  const id = "a".repeat(32);
  let active = true;
  const vault = {
    id,
    mode: "native",
    native: { isCurrent: () => active, canFetchPublicMarket: () => active },
  } as unknown as OpenVault;
  const stores = { vaults: new Map([[id, vault]]) } as unknown as HostStores;
  let key: string | null = null;
  let pending: (() => void) | null = null;
  let delay = false;
  let pendingGet: (() => void) | null = null;
  let delayGet = false;
  const makeSecrets = (): ClassifierSecretStore => ({
    async get() {
      if (delayGet)
        await new Promise<void>((resolve) => {
          pendingGet = resolve;
        });
      return key;
    },
    async set(value) {
      if (delay)
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      key = value;
    },
    async clear() {
      if (delay)
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      key = null;
    },
  });
  const binding = createProductionClassifierBinding({
    dataDir,
    lock,
    stores,
    isCurrentVault: () => active,
    makeSecrets,
    fetch: async () => {
      throw new Error("network forbidden");
    },
  });
  return {
    id,
    stores,
    lock,
    binding,
    setDelay(value: boolean) {
      delay = value;
    },
    setDelayGet(value: boolean) {
      delayGet = value;
    },
    releaseGet() {
      pendingGet?.();
      pendingGet = null;
    },
    release() {
      pending?.();
      pending = null;
    },
    setActive(value: boolean) {
      active = value;
    },
  };
}

it("requires owner action and a fresh key before per-vault cloud consent", async () => {
  const f = fixture();
  try {
    expect(f.binding.cloud.consent(f.id)).toBeNull();
    expect(
      (
        await f.binding.action.run(f.stores, f.id, {
          op: "grantCloud",
          riskCopy: "merchant-name-residual-v1",
          model: "claude-haiku-4-5",
        })
      ).status,
    ).toBe("refused");
    expect(
      (await f.binding.action.run(f.stores, f.id, { op: "setKey", key: "synthetic-key" })).status,
    ).toBe("completed");
    expect(
      (
        await f.binding.action.run(f.stores, f.id, {
          op: "grantCloud",
          riskCopy: "merchant-name-residual-v1",
          model: "claude-haiku-4-5",
        })
      ).status,
    ).toBe("completed");
    const consent = f.binding.cloud.consent(f.id);
    expect(consent?.riskCopy).toBe("merchant-name-residual-v1");
    expect(consent?.isCurrent(f.id)).toBe(true);
    expect((await f.binding.action.run(f.stores, f.id, { op: "revokeCloud" })).status).toBe(
      "completed",
    );
    expect(consent?.isCurrent(f.id)).toBe(false);
    expect(f.binding.cloud.consent(f.id)).toBeNull();
  } finally {
    f.lock.release();
  }
});

it("does not reconcile a status response whose key read overlaps revocation", async () => {
  const f = fixture();
  try {
    await f.binding.action.run(f.stores, f.id, { op: "setKey", key: "synthetic-key" });
    await f.binding.action.run(f.stores, f.id, {
      op: "grantCloud",
      riskCopy: "merchant-name-residual-v1",
      model: "claude-haiku-4-5",
    });
    f.setDelayGet(true);
    const status = f.binding.action.run(f.stores, f.id, { op: "status" });
    f.setDelayGet(false);
    expect((await f.binding.action.run(f.stores, f.id, { op: "revokeCloud" })).status).toBe(
      "completed",
    );
    f.releaseGet();
    expect((await status).status).toBe("outcome_unknown");
    expect(f.binding.cloud.consent(f.id)).toBeNull();
  } finally {
    f.lock.release();
  }
});

it("disarms cloud before delayed key rotation and keeps it off afterward", async () => {
  const f = fixture();
  try {
    await f.binding.action.run(f.stores, f.id, { op: "setKey", key: "synthetic-key" });
    await f.binding.action.run(f.stores, f.id, {
      op: "grantCloud",
      riskCopy: "merchant-name-residual-v1",
      model: "claude-haiku-4-5",
    });
    const old = f.binding.cloud.config(f.id);
    expect(old?.isCurrent(f.id)).toBe(true);
    f.setDelay(true);
    const rotation = f.binding.action.run(f.stores, f.id, {
      op: "setKey",
      key: "new-synthetic-key",
    });
    expect(f.binding.cloud.config(f.id)).toBeNull();
    expect(old?.isCurrent(f.id)).toBe(false);
    expect((await f.binding.action.run(f.stores, f.id, { op: "status" })).status).toBe(
      "not_started",
    );
    await Promise.resolve();
    f.release();
    expect((await rotation).status).toBe("completed");
    expect(f.binding.cloud.config(f.id)).toBeNull();
    const status = await f.binding.action.run(f.stores, f.id, { op: "status" });
    expect(status.status).toBe("completed");
    if (status.status === "completed")
      expect(status.value).toMatchObject({ backend: "ollama", consented: false, keyPresent: true });
  } finally {
    f.lock.release();
  }
});
