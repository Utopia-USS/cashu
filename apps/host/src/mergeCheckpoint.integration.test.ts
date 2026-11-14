import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { investmentsCommands } from "@cashu/store";
import { expect, it } from "vitest";
import { runHostVaultCommand } from "./commands.js";
import { startLocalHost } from "./host.js";
import { withIsolatedNativeCheckpoint } from "./testing/nativeCheckpointInspection.js";
import { nativeVaultFixture } from "./testing/nativeVaultFixture.js";

it("publishes a pre-merge checkpoint, merges once, and retains the keyed result after reopen", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault?.native) throw new Error("native vault missing");
    const create = (name: string, key: string) =>
      runHostVaultCommand(
        vault,
        investmentsCommands.createInstrument,
        { name, assetClass: "equity", currency: "PLN" },
        key,
      );
    const source = await create("Synthetic source", "source-key");
    const target = await create("Synthetic target", "target-key");
    if (source.kind !== "completed" || target.kind !== "completed")
      throw new Error("instruments absent");
    const input = { source: source.value.gid, target: target.value.gid };
    const key = "merge-key";
    const checkpointRoot = join(fixture.dataDir, "vaults", fixture.vaultId, "checkpoints");
    expect(
      await runHostVaultCommand(
        vault,
        investmentsCommands.mergeInstruments,
        { source: source.value.gid, target: source.value.gid },
        "refused-key",
      ),
    ).toEqual({ kind: "refused", reason: "same_instrument" });
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM inv_instruments")).toHaveLength(2);
    expect(existsSync(checkpointRoot)).toBe(false);
    const result = await runHostVaultCommand(
      vault,
      investmentsCommands.mergeInstruments,
      input,
      key,
    );
    expect(result.kind).toBe("completed");
    const published = readdirSync(checkpointRoot);
    expect(published).toHaveLength(1);
    const archive = published[0];
    if (!archive) throw new Error("checkpoint absent");
    expect(archive.startsWith(".")).toBe(false);
    await withIsolatedNativeCheckpoint(
      join(checkpointRoot, archive),
      fixture.recoveryWords,
      fixture.vaultSource.provider.sodium,
      ({ privateDb, viewDb }) => {
        expect(viewDb.prepare("SELECT COUNT(*) AS n FROM inv_instruments").get()).toEqual({ n: 2 });
        expect(
          privateDb.prepare("SELECT COUNT(*) AS n FROM host_attempts WHERE key = ?").get(key),
        ).toEqual({ n: 0 });
      },
    );
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM inv_instruments")).toEqual([
      { gid: target.value.gid },
    ]);
    await host.stop();
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const reopened = host.stores.vaults.get(fixture.vaultId);
    if (!reopened) throw new Error("native vault not reopened");
    expect(
      await runHostVaultCommand(reopened, investmentsCommands.mergeInstruments, input, key),
    ).toEqual(result);
    expect(readdirSync(checkpointRoot)).toEqual(published);
  } finally {
    await host?.stop();
    fixture.cleanup();
  }
});

it("does not record a merge intent when encrypted checkpoint capture fails", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault?.native) throw new Error("native vault missing");
    const source = await runHostVaultCommand(
      vault,
      investmentsCommands.createInstrument,
      { name: "Synthetic source", assetClass: "equity", currency: "PLN" },
      "source-key",
    );
    const target = await runHostVaultCommand(
      vault,
      investmentsCommands.createInstrument,
      { name: "Synthetic target", assetClass: "equity", currency: "PLN" },
      "target-key",
    );
    if (source.kind !== "completed" || target.kind !== "completed")
      throw new Error("instruments absent");
    const input = { source: source.value.gid, target: target.value.gid };
    const logRoot = join(fixture.dataDir, "vaults", fixture.vaultId, "log");
    chmodSync(logRoot, 0o755);
    expect(
      await runHostVaultCommand(vault, investmentsCommands.mergeInstruments, input, "merge-key"),
    ).toEqual({ kind: "not_started", reason: "checkpoint_failed" });
    expect(
      vault.native.attempts.status(vault.id, "merge-key", investmentsCommands.mergeInstruments.id)
        .phase,
    ).toBe("absent");
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM inv_instruments")).toHaveLength(2);
    chmodSync(logRoot, 0o700);
    expect(
      (await runHostVaultCommand(vault, investmentsCommands.mergeInstruments, input, "merge-key"))
        .kind,
    ).toBe("completed");
  } finally {
    await host?.stop();
    fixture.cleanup();
  }
});

it("retains the original key and one checkpoint when a merge reply is lost after append", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault?.native) throw new Error("native vault missing");
    const source = await runHostVaultCommand(
      vault,
      investmentsCommands.createInstrument,
      { name: "Synthetic source", assetClass: "equity", currency: "PLN" },
      "source-key",
    );
    const target = await runHostVaultCommand(
      vault,
      investmentsCommands.createInstrument,
      { name: "Synthetic target", assetClass: "equity", currency: "PLN" },
      "target-key",
    );
    if (source.kind !== "completed" || target.kind !== "completed")
      throw new Error("instruments absent");
    const input = { source: source.value.gid, target: target.value.gid };
    const original = vault.native.engine.write.bind(vault.native.engine);
    vault.native.engine.write = async (...args) => {
      await original(...args);
      throw new Error("synthetic lost reply");
    };
    const key = "merge-unknown-key";
    expect(
      await runHostVaultCommand(vault, investmentsCommands.mergeInstruments, input, key),
    ).toMatchObject({
      kind: "outcome_unknown",
      key,
    });
    const checkpointRoot = join(fixture.dataDir, "vaults", fixture.vaultId, "checkpoints");
    const published = readdirSync(checkpointRoot);
    expect(published).toHaveLength(1);
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM inv_instruments")).toEqual([
      { gid: target.value.gid },
    ]);
    await host.stop();
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const reopened = host.stores.vaults.get(fixture.vaultId);
    if (!reopened) throw new Error("native vault not reopened");
    expect(
      await runHostVaultCommand(reopened, investmentsCommands.mergeInstruments, input, key),
    ).toMatchObject({
      kind: "outcome_unknown",
      key,
    });
    expect(readdirSync(checkpointRoot)).toEqual(published);
    expect(reopened.store.read<{ gid: string }>("SELECT gid FROM inv_instruments")).toEqual([
      { gid: target.value.gid },
    ]);
  } finally {
    await host?.stop();
    fixture.cleanup();
  }
});

it("runs the mutating merge CLI through the guarded native socket", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault) throw new Error("native vault missing");
    const source = await runHostVaultCommand(
      vault,
      investmentsCommands.createInstrument,
      { name: "Synthetic source", assetClass: "equity", currency: "PLN" },
      "source-key",
    );
    const target = await runHostVaultCommand(
      vault,
      investmentsCommands.createInstrument,
      { name: "Synthetic target", assetClass: "equity", currency: "PLN" },
      "target-key",
    );
    if (source.kind !== "completed" || target.kind !== "completed")
      throw new Error("instruments absent");
    const connection = await connectHost({ dataDir: fixture.dataDir, role: "cli", build: "test" });
    try {
      const notes: string[] = [];
      const reply = new Promise<unknown>((resolve, reject) => {
        connection.onFrame((frame: HostFrame) => {
          if (frame.t === "note" && frame.id === 1 && frame.method === "cli.out")
            notes.push(JSON.stringify(frame.params));
          if (frame.t === "res" && frame.id === 1) {
            if (frame.outcome.ok) resolve(frame.outcome.result);
            else reject(new Error(frame.outcome.error.code));
          }
        });
      });
      connection.send({
        t: "req",
        id: 1,
        method: "cli.exec",
        params: {
          argv: [
            "-p",
            fixture.profileSlug,
            "invest",
            "instruments",
            "merge",
            source.value.gid,
            target.value.gid,
          ],
          cwd: fixture.home,
          paths: { home: fixture.home },
          env: { CASHU_LANG: "en" },
          tty: { stdin: false, stdout: false, stderr: false },
        } satisfies CliExecParams,
      });
      expect(await reply).toEqual({ kind: "exit", code: 0 });
      expect(notes.join(" ")).toContain("Merged");
      expect(notes.join(" ")).toContain("Encrypted pre-merge checkpoint:");
    } finally {
      connection.close();
    }
    expect(vault.store.read<{ gid: string }>("SELECT gid FROM inv_instruments")).toEqual([
      { gid: target.value.gid },
    ]);
    expect(
      readdirSync(join(fixture.dataDir, "vaults", fixture.vaultId, "checkpoints")),
    ).toHaveLength(1);
  } finally {
    await host?.stop();
    fixture.cleanup();
  }
});
