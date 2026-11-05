// The loans first steps (ab24ab6 modules/loans/Start.tsx in core/StartPage.tsx): the shared module start frame
// with the loan and installment steps and the Agent AI widget. Pure; the drawers come in as children.
import { S as A } from "@cashu/i18n/core/chrome.strings";
import { S as T } from "@cashu/i18n/loans/Start.strings";
import { AgentWidget, Button, ModuleStart, Tag } from "@cashu/ui";
import type { ReactNode } from "react";
import type { LoansState } from "./useLoansScreen.js";

export interface LoansStartViewProps {
  state: LoansState;
  onGuide(): void;
  onAgentSettings(): void;
  children?: ReactNode;
}

export function LoansStartView({ state, onGuide, onAgentSettings, children }: LoansStartViewProps) {
  const { start } = state;
  return (
    <ModuleStart
      title={T.title}
      tag={<Tag tone={start.tag.tone}>{start.tag.text}</Tag>}
      stepsTitle={A.firstSteps}
      footer={
        <Button variant="link" size="sm" onPress={onGuide}>
          {A.cliGuide}
        </Button>
      }
      steps={
        start.steps?.map((step) => ({
          key: step.key,
          status: step.status,
          title: step.title,
          hint: step.hint,
          tag: step.tag ? <Tag tone="positive">{step.tag}</Tag> : undefined,
          actions: step.actions.length
            ? step.actions.map((action) => (
                <Button
                  key={action.label}
                  variant={action.primary ? "primary" : "secondary"}
                  disabled={state.privacy || state.busy}
                  onPress={action.onPress}
                >
                  {action.label}
                </Button>
              ))
            : undefined,
        })) ?? null
      }
      aside={<AgentWidget privacy={start.mcpPrivacy} onSettings={onAgentSettings} />}
    >
      {children}
    </ModuleStart>
  );
}
