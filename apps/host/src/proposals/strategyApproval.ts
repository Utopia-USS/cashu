// Owner approval of agent strategy and custom-rule proposals (MCP propose_strategy /
// propose_custom_rule, Python `proposals.approve` for those kinds): the checked strategy files of the
// exact open native vault are re-read, the merged result is published through the private
// compensating journal, and the strategy version is recorded in the same S60 decision.
import type { ExecutionSnapshot, ProposalLock } from "@cashu/store/core";
import { prepareStrategyApproval } from "@cashu/store/investments/services";
import type { ProposalApprovalProvider } from "../proposalsScreen.js";
import type { HostStores, OpenVault } from "../stores.js";
import { strategyPublicationPorts } from "./strategyFiles.js";

/** The proposal kinds this provider approves. */
function isStrategyProposalKind(kind: string): boolean {
  return kind === "strategy" || kind === "custom_rule";
}

/** Strategy approvals for every open native vault whose strategy directory authority is live. */
export function nativeStrategyApprovals(input: {
  /** The daily run's lock: an approval never overlaps a daily evaluation of the strategy. */
  readonly dailyLock: ProposalLock;
}): ProposalApprovalProvider {
  const generations = new WeakMap<OpenVault, string>();
  let opened = 0;
  return {
    bind(id: string, stores: HostStores) {
      const vault = stores.vaults.get(id);
      if (vault?.mode !== "native" || !vault.native.isCurrent()) return null;
      const authority = vault.native.strategyDirectoryAuthority();
      if (authority === null || authority.vault !== id) return null;
      let generation = generations.get(vault);
      if (generation === undefined) {
        generation = `strategy:${id}:${vault.native.device}:${++opened}`;
        generations.set(vault, generation);
      }
      const isCurrent = () => {
        try {
          return (
            stores.vaults.get(id) === vault && vault.native.isCurrent() && authority.isCurrent()
          );
        } catch {
          return false;
        }
      };
      return {
        generation,
        dailyLock: input.dailyLock,
        isCurrent,
        // Strategy files are this device's own: no vault leader is needed (proposal-service.ts).
        isHolder: isCurrent,
        async prepare(snapshot: ExecutionSnapshot) {
          if (!isStrategyProposalKind(snapshot.kind)) throw new Error("wrong_kind");
          if (!isCurrent()) throw new Error("strategy_authority_unavailable");
          const ports = strategyPublicationPorts(authority);
          const prepared = await prepareStrategyApproval({
            store: vault.store,
            files: ports.files,
            journal: ports.journal,
            isVaultCurrent: isCurrent,
            proposal: snapshot,
          });
          return { effect: prepared.effect, publication: prepared.publication };
        },
      };
    },
  };
}
