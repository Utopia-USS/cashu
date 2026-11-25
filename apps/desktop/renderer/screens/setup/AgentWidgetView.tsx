// The `Z pomocą Claude Code` card of a module's setup page (ab24ab6 core/SetupPage.tsx): connect the profile's MCP
// server once, run the module's setup skill, what the agent sees at the profile's privacy level. Pure view.
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import {
  Button,
  CodeLine,
  Notice,
  PrivacyLine,
  SectionCard,
  type SetupStepItem,
  SetupSteps,
  Tag,
} from "@cashu/ui";
import { S } from "./Setup.strings.js";
import type { SetupAgentContext } from "./useSetupAgent.js";

export interface AgentWidgetViewProps {
  readonly agent: SetupAgentContext;
  readonly skill: string | null;
  /** The module's note under the skill step (old `def.skillHint`). */
  readonly skillHint?: string | null;
  readonly privacy: string;
  readonly onCopy: (text: string) => void;
  readonly onSettings: () => void;
}

export function AgentWidgetView({
  agent,
  skill,
  skillHint,
  privacy,
  onCopy,
  onSettings,
}: AgentWidgetViewProps) {
  const steps: SetupStepItem[] =
    agent.kind === "ready"
      ? [
          {
            key: "mcp",
            status: "on",
            title: P.connectMcp,
            tag: <Tag>{P.oncePerProfile}</Tag>,
            body: <CodeLine command={agent.mcpAdd} onCopy={() => onCopy(agent.mcpAdd)} />,
            hint: P.desktopHint,
          },
          ...(skill
            ? [
                {
                  key: "skill",
                  status: "todo" as const,
                  title: P.runSkill,
                  body: <CodeLine command={skill} onCopy={() => onCopy(skill)} />,
                  hint: skillHint ?? undefined,
                },
              ]
            : []),
        ]
      : [];
  return (
    <SectionCard id="setup-claude" title={P.withClaude}>
      {steps.length ? (
        <SetupSteps steps={steps} />
      ) : (
        <div className="py-2 text-sm text-fg-muted">{S.agentUnavailable}</div>
      )}
      <Notice
        tone="info"
        className="mt-3"
        action={<Button onPress={onSettings}>{P.settings}</Button>}
      >
        <PrivacyLine privacy={privacy} />
      </Notice>
    </SectionCard>
  );
}
