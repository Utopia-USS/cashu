// The budget first steps page (ab24ab6 modules/budget/Start.tsx in core/StartPage.tsx): the shared module start
// frame with the three steps and the Agent AI widget. Pure; the drawers come in as children.
import { S as A } from "@cashu/i18n/core/chrome.strings";
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { Button, ModuleStart, Tag, Widget } from "@cashu/ui";
import type { ReactNode } from "react";
import type { BudgetStartState } from "./useBudgetStart.js";

export interface BudgetStartViewProps {
  state: BudgetStartState;
  onGuide(): void;
  onAgentSettings(): void;
  children?: ReactNode;
}

export function BudgetStartView({
  state,
  onGuide,
  onAgentSettings,
  children,
}: BudgetStartViewProps) {
  return (
    <ModuleStart
      title={state.title}
      tag={<Tag tone={state.tag.tone}>{state.tag.text}</Tag>}
      stepsTitle={A.firstSteps}
      footer={
        <Button variant="link" size="sm" onPress={onGuide}>
          {A.cliGuide}
        </Button>
      }
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
                  onPress={action.onPress}
                >
                  {action.label}
                </Button>
              ))
            : undefined,
        })) ?? null
      }
      aside={
        <Widget
          title={A.agent}
          tight
          footer={
            <Button variant="link" size="sm" onPress={onAgentSettings}>
              {A.settings}
            </Button>
          }
        >
          <div className="text-sm">
            {state.mcpPrivacy === "amounts" ? (
              <>
                <b>{P.amountsBold}</b>
                {P.amountsText}
              </>
            ) : (
              <>
                <b>{P.strictBold}</b>
                {P.strictText}
              </>
            )}
          </div>
        </Widget>
      }
    >
      {children}
    </ModuleStart>
  );
}
