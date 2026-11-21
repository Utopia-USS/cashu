// The synchronous client over a durable vault handle (the phone's engine-backed vaults): a vault
// command goes to `execute` with the attempt's key, its answer becomes the command outcome, an unknown
// outcome reconciles through `reconcile`, and device commands stay on the device store.
import { renameProfile } from "@cashu/store";
import { setCurrentVault } from "@cashu/store/device";
import { expect, it } from "vitest";
import { DEVICE_TARGET } from "../client/types.js";
import { memoryStores, VAULT_A, VAULT_B } from "../testing/memory.js";
import type { DurableOutcome, DurableVaultHandle, LocalStores } from "./stores.js";
import { createSyncClient } from "./sync.js";

it("routes vault commands of a durable handle through execute and reconcile", async () => {
  const memory = memoryStores();
  const calls: { command: string; input: unknown; key: string }[] = [];
  let next: DurableOutcome = { kind: "completed", value: "done" };
  const durable: DurableVaultHandle = {
    store: (memory.vaults.get(VAULT_A) as { store: DurableVaultHandle["store"] }).store,
    async execute(command, input, key) {
      calls.push({ command: command.id, input, key });
      return next;
    },
    async reconcile(key) {
      calls.push({ command: "reconcile", input: null, key });
      return { kind: "refused", reason: "request_key_conflict" };
    },
  };
  const stores: LocalStores = {
    device: memory.device,
    vaults: new Map([
      [VAULT_A, durable],
      [VAULT_B, memory.vaults.get(VAULT_B) as NonNullable<ReturnType<typeof memory.vaults.get>>],
    ]),
  };
  const client = createSyncClient(stores, { lingerMs: 0 });
  const target = { kind: "vault", vault: VAULT_A } as const;

  expect(await client.run(target, renameProfile, { name: "Ela" })).toEqual({
    kind: "completed",
    value: "done",
  });
  expect(calls[0]).toMatchObject({ command: renameProfile.id, input: { name: "Ela" } });
  expect(calls[0]?.key).toMatch(/.+/);

  next = { kind: "outcome_unknown", attemptId: "a1" };
  const unknown = await client.run(target, renameProfile, { name: "Ula" });
  expect(unknown).toMatchObject({ kind: "outcome_unknown", attemptId: "a1" });
  if (unknown.kind !== "outcome_unknown") throw new Error("expected an unknown outcome");
  expect(unknown.key).toBe(calls[1]?.key);
  expect(await client.reconcile(unknown.attempt)).toEqual({
    kind: "refused",
    reason: "request_key_conflict",
  });
  expect(calls[2]).toEqual({ command: "reconcile", input: null, key: unknown.key });

  // A direct vault and the device store keep their synchronous paths.
  expect(
    await client.run({ kind: "vault", vault: VAULT_B }, renameProfile, { name: "Ola2" }),
  ).toMatchObject({ kind: "completed" });
  expect(await client.run(DEVICE_TARGET, setCurrentVault, { vault: VAULT_B })).toMatchObject({
    kind: "completed",
  });
  expect(calls).toHaveLength(3);
  client.dispose();
  memory.close();
});
