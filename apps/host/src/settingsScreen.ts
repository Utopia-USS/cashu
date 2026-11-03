import { builtinRegistry } from "@cashu/domain/core";
import { enabledModuleIds } from "@cashu/store/core";
import { z } from "zod";
import type { HostStores, OpenVault } from "./stores.js";
import type { UiActionRegistration } from "./uiActions.js";
import type { WorkspaceInspectInput, WorkspaceProvider } from "./workspace/index.js";

const registry = builtinRegistry();
const applyInput = z.object({
  path: z.string().max(4096).optional(),
  force: z.boolean().optional(),
  routinePermissions: z.boolean().optional(),
});

function context(vault: OpenVault): WorkspaceInspectInput | null {
  const profile = vault.store.read<{
    slug: string;
    baseCurrency: string;
    mcpPrivacy: string;
  }>("SELECT slug, base_currency AS baseCurrency, mcp_privacy AS mcpPrivacy FROM profiles")[0];
  if (!profile || !["strict", "amounts"].includes(profile.mcpPrivacy)) return null;
  const enabled = enabledModuleIds(vault.store.read.bind(vault.store));
  return {
    slug: profile.slug,
    baseCurrency: profile.baseCurrency,
    privacy: profile.mcpPrivacy as "strict" | "amounts",
    modules: [...registry.modules.values()]
      .filter((module) => enabled.has(module.id))
      .map((module) => ({ id: module.id, name: module.name })),
  };
}

/** Workspace filesystem actions are available only through a current exact-vault provider. */
export function settingsWorkspaceActions(
  provider?: WorkspaceProvider,
): readonly UiActionRegistration[] {
  const act = (kind: "inspect" | "apply"): UiActionRegistration => ({
    id: kind === "inspect" ? "core.settings.workspaceInspect" : "core.settings.workspaceApply",
    async run(stores: HostStores, target: string, raw: unknown, sessionCurrent = () => true) {
      const parsed = kind === "apply" ? applyInput.safeParse(raw) : z.object({}).safeParse(raw);
      if (!parsed.success)
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      const vault = stores.vaults.get(target);
      if (!vault) return { status: "refused", reason: "unknown_target", preparation: "none" };
      const binding = provider?.bind(target);
      if (!binding?.isCurrent()) {
        if (kind === "inspect")
          return {
            status: "completed",
            value: { availability: "unavailable", reason: "source_unbound" },
          };
        return { status: "refused", reason: "capability_unavailable", preparation: "none" };
      }
      const current = () =>
        sessionCurrent() &&
        stores.vaults.get(target) === vault &&
        provider?.bind(target)?.generation === binding.generation &&
        binding.isCurrent();
      const source = context(vault);
      if (!source) return { status: "refused", reason: "no_profile", preparation: "none" };
      const fingerprint = JSON.stringify(source);
      const operationCurrent = () => current() && JSON.stringify(context(vault)) === fingerprint;
      if (!operationCurrent())
        return { status: "refused", reason: "authority_lost", preparation: "none" };
      try {
        const value =
          kind === "inspect"
            ? await binding.inspect(source)
            : await binding.apply({
                ...source,
                ...applyInput.parse(raw),
                isCurrent: operationCurrent,
              });
        if (!operationCurrent()) return { status: "outcome_unknown", reason: "interrupted" };
        return { status: "completed", value };
      } catch {
        return { status: "outcome_unknown", reason: "unexpected_failure" };
      }
    },
  });
  return [act("inspect"), act("apply")];
}
