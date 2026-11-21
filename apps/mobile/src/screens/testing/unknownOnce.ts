// A synthetic money kit whose vault A answers like the phone's engine-backed (durable) vault, except that
// the first command it runs is written but answered `outcome_unknown` (an acknowledgement lost after the
// write). A later reconcile answers from what the store really holds: completed for an attempt that was
// written. The tests' oracle is the store's own rows. Synthetic data only.
import { type Command, runCommand } from "@cashu/store";
import {
  createSyncClient,
  type DurableOutcome,
  type DurableVaultHandle,
  type VaultHandle,
} from "@cashu/store-react/local";
import type { Services } from "../../services/services";
import { MONEY_VAULT_A, MONEY_VAULT_B, type MoneyStore } from "./moneyStore";

export interface UnknownOnce {
  readonly client: ReturnType<typeof createSyncClient>;
  readonly services: Services;
  /** The attempts the vault ran, in order (each one written once). */
  readonly executed: string[];
}

export function unknownOnce(fixture: MoneyStore): UnknownOnce {
  const handle: VaultHandle = fixture.a;
  const written = new Map<string, DurableOutcome>();
  const executed: string[] = [];
  const durable: DurableVaultHandle = {
    store: handle.store,
    async execute(command: Command<unknown, unknown>, input: unknown, key: string) {
      const known = written.get(key);
      if (known !== undefined) return known;
      executed.push(key);
      const result = runCommand(handle.store, handle.writer, command, input, handle.env);
      const outcome: DurableOutcome = result.ok
        ? { kind: "completed", value: result.value }
        : { kind: "refused", reason: result.reason };
      written.set(key, outcome);
      // The first attempt's answer is lost after the write.
      return executed.length === 1 ? { kind: "outcome_unknown", attemptId: key } : outcome;
    },
    async reconcile(key: string) {
      return written.get(key) ?? { kind: "not_started", reason: "no_journal_entry" };
    },
  };
  const client = createSyncClient(
    {
      device: fixture.device,
      vaults: new Map<string, VaultHandle | DurableVaultHandle>([
        [MONEY_VAULT_A, durable],
        [MONEY_VAULT_B, fixture.b],
      ]),
    },
    { lingerMs: 0 },
  );
  return { client, services: { ...fixture.services, client }, executed };
}
