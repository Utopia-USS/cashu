// What the `Z pomocą Claude Code` card needs for one module: the profile's MCP command and CLI prefix from the host,
// the module's setup skill and the profile's MCP privacy level. Shared by the setup page and the module first steps.
import { claudeMcpAdd, cliPrefix } from "@cashu/domain/core";
import { lang } from "@cashu/i18n";
import { S as INVESTMENTS } from "@cashu/i18n/investments/index.strings";
import { profile } from "@cashu/store/core";
import { hostSettingsInfo } from "@cashu/store/core/desktop-settings";
import { overviewQueries, profileIdentity } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";

export type SetupAgentContext =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "ready"; readonly cliPrefix: string; readonly mcpAdd: string };

const q = overviewQueries({ prices: null });

export function useSetupAgent(moduleId: string) {
  const identity = useQuery(profile);
  const slug = useQuery(profileIdentity)?.slug ?? null;
  // The stable launcher and the flavor's MCP server prefix the host reports (Settings > Agent AI reads
  // the same query).
  const host = useQuery(hostSettingsInfo, { privacy: false });
  const agent: SetupAgentContext =
    host.availability !== "ready" || !host.launcher || !host.mcpServerPrefix || !slug
      ? { kind: "unavailable", reason: "launcher_unavailable" }
      : {
          kind: "ready",
          cliPrefix: cliPrefix([host.launcher], slug),
          mcpAdd: claudeMcpAdd([host.launcher], slug, host.mcpServerPrefix),
        };
  const setup = useQuery(q.moduleSetup, {
    module: moduleId,
    cli: agent.kind === "ready" ? agent.cliPrefix : "",
    lang: lang(),
  });
  return {
    agent,
    skill: setup.ok ? setup.value.skill : null,
    /** The module's note under the skill step (old `def.skillHint`). */
    skillHint: moduleId === "investments" ? INVESTMENTS.skillHint : null,
    mcpPrivacy: identity?.mcpPrivacy ?? "strict",
  };
}
