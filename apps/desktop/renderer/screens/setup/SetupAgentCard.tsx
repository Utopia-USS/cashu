// The `Z pomocą Claude Code` card bound to one module, for the module first steps (budget, loans, assets): the same
// card as the setup page, always under the steps. Copies toast through the page's ToastProvider.
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { useToast } from "@cashu/ui";
import { AgentWidgetView } from "./AgentWidgetView.js";
import { S } from "./Setup.strings.js";
import { useSetupAgent } from "./useSetupAgent.js";

const COPY_TOAST_MS = 1500;

export interface SetupAgentCardProps {
  readonly moduleId: string;
  /** `Ustawienia` on the privacy line: Ustawienia › Agent AI. */
  readonly onSettings: () => void;
}

export function SetupAgentCard({ moduleId, onSettings }: SetupAgentCardProps) {
  const { agent, skill, skillHint, mcpPrivacy } = useSetupAgent(moduleId);
  const toast = useToast();
  return (
    <AgentWidgetView
      agent={agent}
      skill={skill}
      skillHint={skillHint}
      privacy={mcpPrivacy}
      onCopy={(text) => {
        navigator.clipboard.writeText(text).then(
          () => toast(P.copied, COPY_TOAST_MS),
          () => toast(S.copyFailed, COPY_TOAST_MS),
        );
      }}
      onSettings={onSettings}
    />
  );
}
