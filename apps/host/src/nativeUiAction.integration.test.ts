import type { StoreToClient } from "@cashu/host-protocol/store";
import { renameProfile } from "@cashu/store";
import { expect, it } from "vitest";
import { z } from "zod";
import { startLocalHost } from "./host.js";
import { storeClient } from "./testing/harness.js";
import { nativeVaultFixture } from "./testing/nativeVaultFixture.js";
import { defineUiAction } from "./uiActions.js";

it("dispatches an injected UI action through a native encrypted host", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  const key = "01K9B2W0000000000000000011";
  const action = defineUiAction({
    id: "test.nativeRename",
    module: "budget",
    input: z.strictObject({ name: z.string() }),
    commands: [renameProfile],
    bind: (vault) =>
      vault === fixture.vaultId
        ? { generation: "synthetic-current", capabilities: {}, isCurrent: () => true }
        : null,
    async run(context, input) {
      const outcome = await context.execute({ command: renameProfile.id, input, key });
      if (outcome.kind === "completed") return { status: "completed", value: null };
      if (outcome.kind === "outcome_unknown")
        return {
          status: "outcome_unknown",
          reason: "interrupted",
          attempt: { key: outcome.key, command: renameProfile.id },
        };
      return outcome.kind === "not_started"
        ? { status: "not_started", reason: "capability_unavailable" as const }
        : { status: "refused", reason: outcome.reason, preparation: "none" };
    },
  });
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    uiActions: [action],
  } as const;
  const host = await startLocalHost(options);
  let reopened: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  const client = await storeClient(fixture.dataDir);
  try {
    const rid = 777;
    const reply = new Promise<StoreToClient>((resolve, reject) => {
      const seen: string[] = [];
      const timeout = setTimeout(
        () => reject(new Error(`action response missing: ${seen.join(",")}`)),
        1500,
      );
      client.conn.onFrame((frame) => {
        if (frame.t !== "store") return;
        const message = frame.m as StoreToClient;
        seen.push(message.t);
        if (message.t === "actionResult" && message.rid === rid) {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    client.conn.send({
      t: "store",
      m: {
        t: "action",
        rid,
        target: { kind: "vault", vault: fixture.vaultId },
        action: action.id,
        input: { name: "Via native action" },
      },
    });
    expect(await reply).toMatchObject({ result: { status: "completed" } });
    const vault = host.stores.vaults.get(fixture.vaultId);
    expect(vault?.native?.attempts.status(fixture.vaultId, key, renameProfile.id)).toMatchObject({
      phase: "completed",
    });
    expect(vault?.store.read<{ name: string }>("SELECT name FROM profiles")).toEqual([
      { name: "Via native action" },
    ]);
    client.close();
    await host.stop();
    reopened = await startLocalHost({ ...options, uiActions: [] });
    expect(
      reopened.stores.vaults
        .get(fixture.vaultId)
        ?.store.read<{ name: string }>("SELECT name FROM profiles"),
    ).toEqual([{ name: "Via native action" }]);
  } finally {
    client.close();
    await reopened?.stop();
    await host.stop();
    fixture.cleanup();
  }
});
