import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_PROTOCOL,
  NATIVE_CREATION_FEATURE,
  nativeCreationPrepareResultSchema,
} from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { cleanup, tempDir } from "./testing/harness.js";

afterEach(cleanup);

it("treats an old Python cashU database in the data dir as no data and leaves it untouched", async () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, "cashu.db"), "synthetic", { mode: 0o600 });
  const host = await startLocalHost({
    dataDir,
    home: tempDir(),
    vaultSource: { kind: "native-production", factory: new ProductionVaultSourceFactory(dataDir) },
    launcher: false,
  });
  const ui = await connectHost({ dataDir, role: "ui", build: "creation-rpc-test" });
  try {
    expect(host.stores.vaults.size).toBe(0);
    expect(await ui.call("native.creation.current", {})).toEqual({ kind: "none" });
    const prepared = nativeCreationPrepareResultSchema.parse(
      await ui.call("native.creation.prepare", {
        name: "Synthetic",
        slug: "synthetic",
        baseCurrency: "PLN",
        modules: [],
        mcpPrivacy: "strict",
      }),
    );
    expect(prepared.kind).toBe("prepared");
    expect(readFileSync(join(dataDir, "cashu.db"), "utf8")).toBe("synthetic");
  } finally {
    ui.close();
    await host.stop();
  }
});

it("serves clean first-run Create under the real host lock with zero vaults", async () => {
  const dataDir = tempDir();
  const host = await startLocalHost({
    dataDir,
    home: tempDir(),
    vaultSource: { kind: "native-production", factory: new ProductionVaultSourceFactory(dataDir) },
    launcher: false,
  });
  const ui = await connectHost({ dataDir, role: "ui", build: "creation-rpc-test" });
  try {
    expect(host.server.lock.held).toBe(true);
    expect(host.stores.vaults.size).toBe(0);
    expect(ui.host.protocol).toEqual(HOST_PROTOCOL);
    expect(ui.host.features).toContain(NATIVE_CREATION_FEATURE);
    expect(await ui.call("native.creation.current", {})).toEqual({ kind: "none" });
    const prepared = nativeCreationPrepareResultSchema.parse(
      await ui.call("native.creation.prepare", {
        name: "Synthetic",
        slug: "synthetic",
        baseCurrency: "PLN",
        modules: [],
        mcpPrivacy: "strict",
      }),
    );
    expect(prepared.kind).toBe("prepared");
    expect(await ui.call("native.creation.current", {})).toEqual({ kind: "none" });
    expect(existsSync(join(dataDir, "native", "v1", "creation.json"))).toBe(false);
    expect(existsSync(join(dataDir, "vaults"))).toBe(false);
    await expect(ui.call("native.creation.delete", {})).rejects.toThrow();
  } finally {
    ui.close();
    await host.stop();
  }
});

it("refuses the Create RPC to an older UI minor even when the host advertises the feature", async () => {
  const dataDir = tempDir();
  const host = await startLocalHost({
    dataDir,
    home: tempDir(),
    vaultSource: { kind: "native-production", factory: new ProductionVaultSourceFactory(dataDir) },
    launcher: false,
  });
  const old = await connectHost({
    dataDir,
    role: "ui",
    build: "creation-rpc-test",
    protocol: { major: 1, minor: 2 },
  });
  try {
    await expect(old.call("native.creation.current", {})).rejects.toThrow();
  } finally {
    old.close();
    await host.stop();
  }
});

it("refuses a new Create request on an existing UI session after shutdown begins", async () => {
  const dataDir = tempDir();
  const host = await startLocalHost({
    dataDir,
    home: tempDir(),
    vaultSource: { kind: "native-production", factory: new ProductionVaultSourceFactory(dataDir) },
    launcher: false,
  });
  const ui = await connectHost({ dataDir, role: "ui", build: "creation-rpc-test" });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = host.stores.device.queue.run(() => held);
  const stopping = host.stop();
  try {
    expect(host.server.stopping).toBe(true);
    await expect(
      ui.call("native.creation.prepare", {
        name: "Synthetic",
        slug: "synthetic",
        baseCurrency: "PLN",
        modules: [],
        mcpPrivacy: "strict",
      }),
    ).rejects.toMatchObject({ code: "stopping" });
    expect(existsSync(join(dataDir, "native", "v1", "creation.json"))).toBe(false);
    expect(existsSync(join(dataDir, "vaults"))).toBe(false);
  } finally {
    release();
    await queued;
    await stopping;
    ui.close();
  }
});
