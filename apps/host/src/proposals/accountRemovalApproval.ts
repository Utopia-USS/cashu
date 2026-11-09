// Owner approval of agent account-removal proposals (MCP propose_account_removal): approving one
// removes the bank account from view under the approval's causal edge (store
// budget/account-removal.ts). No files and no fetch lease are involved, so any current native device
// of the vault may approve it, as a strategy proposal.
import { prepareAccountRemoval } from "@cashu/store";
import type { ExecutionSnapshot, ProposalLock } from "@cashu/store/core";
import type { ProposalApprovalProvider } from "../proposalsScreen.js";
import type { HostStores, OpenVault } from "../stores.js";

export function nativeAccountRemovalApprovals(input: {
  /** The daily run's lock: an approval never overlaps a daily pass. */
  readonly dailyLock: ProposalLock;
}): ProposalApprovalProvider {
  const generations = new WeakMap<OpenVault, string>();
  let opened = 0;
  return {
    bind(id: string, stores: HostStores) {
      const vault = stores.vaults.get(id);
      if (vault?.mode !== "native" || !vault.native.isCurrent()) return null;
      let generation = generations.get(vault);
      if (generation === undefined) {
        generation = `account-removal:${id}:${vault.native.device}:${++opened}`;
        generations.set(vault, generation);
      }
      const isCurrent = () => {
        try {
          return stores.vaults.get(id) === vault && vault.native.isCurrent();
        } catch {
          return false;
        }
      };
      return {
        generation,
        dailyLock: input.dailyLock,
        isCurrent,
        isHolder: isCurrent,
        async prepare(snapshot: ExecutionSnapshot) {
          if (snapshot.kind !== "account_removal") throw new Error("wrong_kind");
          if (!isCurrent()) throw new Error("account_authority_unavailable");
          const prepared = prepareAccountRemoval(vault.store.read.bind(vault.store), snapshot);
          if (!prepared.ok) throw new Error(prepared.reason);
          return { effect: prepared.value };
        },
      };
    },
  };
}
