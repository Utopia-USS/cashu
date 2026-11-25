import { connectHost, NodeFolderFs } from "@cashu/node-host";
import { mintUlid } from "@cashu/store";
import { crypto, ownBatchDigest } from "@cashu/sync";
import { expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { privateNotificationIntents } from "../notifications/intentLedger.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { WorkerAuthorityLost, workerGuard } from "../worker/authority.js";
import {
  emptyWorkerState,
  type WorkerBindings,
  type WorkerHostContext,
} from "../worker/contracts.js";

it("reviews a local-start target and commits one recovery-authorized revoke under the native host", async () => {
  const fixture = await nativeVaultFixture({ pairPeer: true });
  const peer = fixture.peerDevice;
  if (!peer) throw new Error("synthetic peer missing");
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    launcher: false,
  });
  const ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "device-test" });
  try {
    const listed = (await host.stores.vaults.get(fixture.vaultId)?.native?.deviceList()) as {
      kind: string;
      devices?: { id: string }[];
    };
    expect(listed.kind).toBe("ready");
    expect(listed.devices?.some((device) => device.id === peer)).toBe(true);
    const preview = (await ui.call("native.devices.revokePreview", {
      vault: fixture.vaultId,
      targets: [peer],
      recertify: [],
    })) as {
      kind: string;
      token?: string;
      operationId?: string;
      localStartConfirmationRequired?: boolean;
    };
    expect(preview.kind).toBe("prepared");
    expect(preview.localStartConfirmationRequired).toBe(true);
    if (!preview.token || !preview.operationId) throw new Error("preview unavailable");
    const phrase = fixture.recoveryWords;
    expect(JSON.stringify(preview).includes(phrase)).toBe(false);
    const incomplete = (await ui.call("native.devices.revokeCommit", {
      vault: fixture.vaultId,
      token: preview.token,
      warningAcknowledgement: "revoke_risk_acknowledged",
      recoveryPhrase: phrase,
    })) as { kind: string };
    expect(incomplete.kind).toBe("refused");
    const second = (await ui.call("native.devices.revokePreview", {
      vault: fixture.vaultId,
      targets: [peer],
      recertify: [],
    })) as { kind: string; token?: string; operationId?: string };
    if (!second.token || !second.operationId) throw new Error("second preview unavailable");
    const completed = (await ui.call("native.devices.revokeCommit", {
      vault: fixture.vaultId,
      token: second.token,
      warningAcknowledgement: "revoke_risk_acknowledged",
      localStartAcknowledgement: "local_target_stream_never_seen",
      recoveryPhrase: phrase,
    })) as { kind: string };
    expect(completed.kind).toBe("completed");
    expect(JSON.stringify(completed).includes(phrase)).toBe(false);
    const inspection = (await ui.call("native.devices.revokeInspect", {
      vault: fixture.vaultId,
      operationId: second.operationId,
    })) as { kind: string };
    expect(inspection.kind).toBe("completed");
    expect(JSON.stringify(inspection).includes(phrase)).toBe(false);
    const native = host.stores.vaults.get(fixture.vaultId)?.native;
    const attempt = native?.attempts.status(
      fixture.vaultId,
      second.operationId,
      "native.devices.revokeCommit",
    );
    expect(JSON.stringify(attempt).includes(phrase)).toBe(false);
    expect(attempt?.phase).toBe("completed");
    const after = (await host.stores.vaults.get(fixture.vaultId)?.native?.deviceList()) as {
      kind: string;
      devices?: { id: string; revoked: boolean }[];
    };
    expect(after.devices?.find((device) => device.id === peer)?.revoked).toBe(true);
  } finally {
    ui.close();
    await host.stop();
    fixture.cleanup();
  }
});

for (const failure of ["append_response_lost", "ring_save_response_lost"] as const) {
  it(`recovers the same revoke operation after ${failure} and cold reopen`, async () => {
    const fixture = await nativeVaultFixture({ pairPeer: true });
    const peer = fixture.peerDevice;
    if (!peer) throw new Error("synthetic peer missing");
    const keyStore = fixture.vaultSource.provider.keyStore;
    const originalSet = keyStore.set.bind(keyStore);
    const originalRename = NodeFolderFs.prototype.rename;
    let armed = true;
    let renameSpy: ReturnType<typeof vi.spyOn> | undefined;
    let host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      vaultSource: fixture.vaultSource,
      launcher: false,
    });
    let ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "device-test" });
    try {
      const preview = (await ui.call("native.devices.revokePreview", {
        vault: fixture.vaultId,
        targets: [peer],
        recertify: [],
      })) as { kind: string; token?: string; operationId?: string };
      if (preview.kind !== "prepared" || !preview.token || !preview.operationId)
        throw new Error("preview unavailable");
      const operationId = preview.operationId;
      const before = await keyStore.get(crypto.keyringName(fixture.vaultId));
      if (!before) throw new Error("synthetic keyring missing");
      if (failure === "append_response_lost") {
        renameSpy = vi.spyOn(NodeFolderFs.prototype, "rename").mockImplementation(async function (
          this: NodeFolderFs,
          from,
          to,
        ) {
          await originalRename.call(this, from, to);
          if (armed && to.includes(fixture.vaultId)) {
            armed = false;
            throw new Error("simulated append response loss");
          }
        });
      } else {
        keyStore.set = async (name, value) => {
          await originalSet(name, value);
          if (armed && name === crypto.keyringName(fixture.vaultId)) {
            armed = false;
            throw new Error("simulated ring save response loss");
          }
        };
      }
      const result = (await ui
        .call("native.devices.revokeCommit", {
          vault: fixture.vaultId,
          token: preview.token,
          warningAcknowledgement: "revoke_risk_acknowledged",
          localStartAcknowledgement: "local_target_stream_never_seen",
          recoveryPhrase: fixture.recoveryWords,
        })
        .catch(() => null)) as { kind: string } | null;
      expect(result === null || result.kind === "outcome_unknown").toBe(true);
      expect(armed).toBe(false);
      renameSpy?.mockRestore();
      keyStore.set = originalSet;
      const after = await keyStore.get(crypto.keyringName(fixture.vaultId));
      expect(
        after !== null &&
          (Buffer.compare(before, after) === 0) === (failure === "append_response_lost"),
      ).toBe(true);
      ui.close();
      await host.stop();

      host = await startLocalHost({
        dataDir: fixture.dataDir,
        home: fixture.home,
        vaultSource: fixture.vaultSource,
        launcher: false,
      });
      ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "device-test" });
      const listed = (await host.stores.vaults.get(fixture.vaultId)?.native?.deviceList()) as {
        kind: string;
        operations?: { operationId: string; phase: string }[];
      };
      expect(
        listed.operations?.some(
          (operation) => operation.operationId === operationId && operation.phase === "completed",
        ),
      ).toBe(true);
      expect(host.stores.vaults.get(fixture.vaultId)?.native?.canRunSideEffects()).toBe(true);
      const inspected = (await ui.call("native.devices.revokeInspect", {
        vault: fixture.vaultId,
        operationId,
      })) as { kind: string; operationId?: string };
      expect(inspected).toEqual({ kind: "completed", operationId });
      const native = host.stores.vaults.get(fixture.vaultId)?.native;
      if (!native) throw new Error("reopened native vault unavailable");
      expect(native.canRunSideEffects()).toBe(true);
      const event = { t: "synthetic.reopenProof", v: 1, i: mintUlid(Date.now()), d: {} };
      await native.queue.run(() => native.engine.write([event]));
      ui.close();
      await host.stop();
      host = await startLocalHost({
        dataDir: fixture.dataDir,
        home: fixture.home,
        vaultSource: fixture.vaultSource,
        launcher: false,
      });
      const third = host.stores.vaults.get(fixture.vaultId)?.native;
      if (!third) throw new Error("second reopened native vault unavailable");
      expect(
        await third.engine.inspectOwnBatch({ eids: [event.i], digest: ownBatchDigest([event]) }),
      ).toBe("committed");
    } finally {
      renameSpy?.mockRestore();
      keyStore.set = originalSet;
      ui.close();
      await host.stop();
      fixture.cleanup();
    }
  });
}

it("marks the original keyed revoke not started only after a complete cold own-tail audit", async () => {
  const fixture = await nativeVaultFixture({ pairPeer: true });
  const peer = fixture.peerDevice;
  if (!peer) throw new Error("synthetic peer missing");
  let host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    launcher: false,
  });
  let ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "device-test" });
  let renameSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const preview = (await ui.call("native.devices.revokePreview", {
      vault: fixture.vaultId,
      targets: [peer],
      recertify: [],
    })) as { kind: string; token?: string; operationId?: string };
    if (preview.kind !== "prepared" || !preview.token || !preview.operationId)
      throw new Error("preview unavailable");
    const operationId = preview.operationId;
    renameSpy = vi.spyOn(NodeFolderFs.prototype, "rename").mockImplementation(async () => {
      throw new Error("simulated append before durable rename");
    });
    const result = (await ui
      .call("native.devices.revokeCommit", {
        vault: fixture.vaultId,
        token: preview.token,
        warningAcknowledgement: "revoke_risk_acknowledged",
        localStartAcknowledgement: "local_target_stream_never_seen",
        recoveryPhrase: fixture.recoveryWords,
      })
      .catch(() => null)) as { kind: string } | null;
    expect(result === null || result.kind === "outcome_unknown").toBe(true);
    renameSpy.mockRestore();
    ui.close();
    await host.stop();
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      vaultSource: fixture.vaultSource,
      launcher: false,
    });
    ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "device-test" });
    expect(host.stores.vaults.get(fixture.vaultId)?.native?.canRunSideEffects()).toBe(true);
    const inspected = await ui.call("native.devices.revokeInspect", {
      vault: fixture.vaultId,
      operationId,
    });
    expect(inspected).toEqual({ kind: "not_started", operationId });
    const terminal = host.stores.vaults
      .get(fixture.vaultId)
      ?.native?.attempts.status(fixture.vaultId, operationId, "native.devices.revokeCommit");
    expect(terminal?.phase).toBe("terminal");
    expect(
      terminal && terminal.phase === "terminal" && terminal.result.kind === "not_started",
    ).toBe(true);
    expect(host.stores.vaults.get(fixture.vaultId)?.native?.canRunSideEffects()).toBe(true);
    expect(
      await ui.call("native.devices.revokeInspect", { vault: fixture.vaultId, operationId }),
    ).toEqual({ kind: "not_started", operationId });
  } finally {
    renameSpy?.mockRestore();
    ui.close();
    await host.stop();
    fixture.cleanup();
  }
});

it("keeps read and pull open while a bounded fetch and other effects lose authority", async () => {
  const fixture = await nativeVaultFixture();
  let context: WorkerHostContext | undefined;
  const bindings: WorkerBindings = {
    state: { load: async () => emptyWorkerState(), save: async () => {} },
    ownership: { isExclusive: () => true },
    authority: () => ({ isHolder: () => true }),
    language: () => "en",
  };
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    launcher: false,
    worker: (current) => {
      context = current;
      return bindings;
    },
  });
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    const native = vault?.native;
    if (!vault || !native || !context) throw new Error("synthetic native worker unavailable");
    const admission = vi
      .spyOn(native.engine, "writeAdmission")
      .mockReturnValue("authority-unresolved");
    const bounded = vi.spyOn(native.engine, "leaseTransport").mockReturnValue({
      kind: "bounded",
      propagationMs: 1000,
      lastPullAt: Date.now(),
      lastPushAt: Date.now(),
    });
    try {
      expect(native.isCurrent()).toBe(true);
      expect((await native.deviceList()).kind).toBe("ready");
      await native.sync();
      expect(native.canRunSideEffects()).toBe(false);
      expect(vault.env.lease.isHolder()).toBe(false);
      expect(context.isCurrent(vault)).toBe(false);
      const guard = workerGuard(
        { ...context, jobsEnabled: () => true, networkEnabled: () => true },
        bindings,
        vault,
        "connectors.fetch",
        { network: true },
      );
      expect(() => guard()).toThrow(WorkerAuthorityLost);
      const ledger = privateNotificationIntents(fixture.dataDir, () => true, Date.now);
      const intent = ledger.reserve({
        vaultId: fixture.vaultId,
        kind: "signalsSummary",
        locale: "en",
      });
      const ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "device-test" });
      try {
        expect(
          await ui.call("native.notification.resolve", {
            requestId: intent.requestId,
            intentToken: intent.intentToken,
          }),
        ).toEqual({ kind: "target", vaultId: fixture.vaultId, target: "signalsSummary" });
      } finally {
        ui.close();
      }
      const connection = await connectHost({
        dataDir: fixture.dataDir,
        role: "mcp",
        profile: fixture.profileSlug,
        build: "device-test",
      });
      try {
        const client = mcpClient(
          (line) => connection.send({ t: "mcp", line }),
          (handler) =>
            connection.onFrame((frame) => {
              if (frame.t === "mcp") handler(frame.line);
            }),
        );
        await connection.call("mcp.open", { cwd: fixture.dataDir, env: {} });
        await initializeMcp(client);
        const read = await client.call("tools/call", {
          name: "setup_status",
          arguments: { module: "budget" },
        });
        expect((read.result as Record<string, unknown>).isError).not.toBe(true);
      } finally {
        connection.close();
      }
    } finally {
      admission.mockRestore();
      bounded.mockRestore();
    }
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});
