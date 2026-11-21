// The budget first steps page (ab24ab6 modules/budget/Start.tsx in core/StartPage.tsx): the shared module start
// frame with the three steps and the Claude Code card under them. Pure; the card and the drawers come in.
import { S as A } from "@cashu/i18n/core/chrome.strings";
import { Button, ModuleStart, Tag } from "@cashu/ui";
import type { ReactNode } from "react";
import type { BudgetStartState } from "./useBudgetStart.js";

export interface BudgetStartViewProps {
  state: BudgetStartState;
  /** The `Z pomocą Claude Code` card under the steps. */
  agent?: ReactNode;
  children?: ReactNode;
}

export function BudgetStartView({ state, agent, children }: BudgetStartViewProps) {
  return (
    <ModuleStart
      title={state.title}
      tag={<Tag tone={state.tag.tone}>{state.tag.text}</Tag>}
      stepsTitle={A.firstSteps}
      steps={
        state.steps?.map((step) => ({
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
                  disabled={action.disabled}
                  onPress={action.onPress}
                >
                  {action.label}
                </Button>
              ))
            : undefined,
        })) ?? null
      }
      below={agent}
    >
      {children}
    </ModuleStart>
  );
}
