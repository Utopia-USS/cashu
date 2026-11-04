import { S } from "./Setup.strings.js";
import type { SetupAgentContext } from "./useSetupScreen.js";

export interface AgentWidgetViewProps {
  readonly agent: SetupAgentContext;
  readonly skill: string | null;
  readonly privacy: string;
  readonly onCopy: (text: string) => void;
  readonly onSettings: () => void;
}

export function AgentWidgetView({
  agent,
  skill,
  privacy,
  onCopy,
  onSettings,
}: AgentWidgetViewProps) {
  return (
    <section className="grid gap-3 rounded-lg border border-border bg-surface-raised p-6">
      <h2 className="text-title">{S.agentTitle}</h2>
      {agent.kind === "unavailable" ? (
        <p>{S.agentUnavailable}</p>
      ) : (
        <>
          {agent.translocated && <p role="note">{S.translocated}</p>}
          <p>{S.connectOnce}</p>
          <div className="flex items-center gap-3">
            <code className="min-w-0 flex-1 break-all">{agent.mcpAdd}</code>
            <button type="button" onClick={() => onCopy(agent.mcpAdd)}>
              {S.copy}
            </button>
          </div>
          {skill && (
            <>
              <p>{S.runSkill}</p>
              <div className="flex items-center gap-3">
                <code className="min-w-0 flex-1 break-all">{skill}</code>
                <button type="button" onClick={() => onCopy(skill)}>
                  {S.copy}
                </button>
              </div>
            </>
          )}
        </>
      )}
      <p>{privacy === "amounts" ? S.privacyAmounts : S.privacyStrict}</p>
      <button type="button" onClick={onSettings}>
        {S.settings}
      </button>
    </section>
  );
}
