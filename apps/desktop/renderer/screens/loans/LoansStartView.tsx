// The loans first steps (ab24ab6 modules/loans/Start.tsx in core/StartPage.tsx): the shared module start frame
// with the loan and installment steps and the Claude Code card under them. Pure; the card and the drawers come in.
import { S as A } from "@cashu/i18n/core/chrome.strings";
import { S as T } from "@cashu/i18n/loans/Start.strings";
import { Button, ModuleStart, Tag } from "@cashu/ui";
import type { ReactNode } from "react";
import type { LoansState } from "./useLoansScreen.js";

export interface LoansStartViewProps {
  state: LoansState;
  /** The `Z pomocą Claude Code` card under the steps. */
  agent?: ReactNode;
  children?: ReactNode;
}

export function LoansStartView({ state, agent, children }: LoansStartViewProps) {
  const { start } = state;
  return (
    <ModuleStart
      title={T.title}
      tag={<Tag tone={start.tag.tone}>{start.tag.text}</Tag>}
      stepsTitle={A.firstSteps}
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
                  disabled={state.busy}
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
