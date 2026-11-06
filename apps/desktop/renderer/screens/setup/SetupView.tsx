// A module's setup page (ab24ab6 core/SetupPage.tsx): the `{Moduł} · konfiguracja` card with the steps tag, the
// configured notice, the steps with their actions, then the `Z pomocą Claude Code` card. Native states (unknown
// module, module off) show their own line in the same card. Pure view.
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { S as STEPS } from "@cashu/i18n/core/setupSteps.strings";
import {
  Button,
  Notice,
  Page,
  SectionCard,
  SetupSteps,
  Tag,
  ToastProvider,
  useToast,
} from "@cashu/ui";
import { useEffect } from "react";
import { AgentWidgetView } from "./AgentWidgetView.js";
import { S } from "./Setup.strings.js";
import type { SetupScreenState } from "./useSetupScreen.js";

/** `→` after a tab name on the configured notice's button (old `{firstTab.label} →`). */
const ARROW = " →";
const COPY_TOAST_MS = 1500;

export function SetupView({ state }: { state: SetupScreenState }) {
  return (
    <ToastProvider>
      <Page width="narrow" label={P.configTitle(state.name)} testID="native-setup">
        <SetupCards state={state} />
      </Page>
    </ToastProvider>
  );
}

function CopyToast({ notice }: { notice: SetupScreenState["notice"] }) {
  const toast = useToast();
  const n = notice?.n;
  const text = notice?.text;
  useEffect(() => {
    if (n !== undefined && text) toast(text, COPY_TOAST_MS);
  }, [n, text, toast]);
  return null;
}

function StepsTag({ state }: { state: SetupScreenState }) {
  if (state.setupState === "ready") return <Tag tone="positive">{P.ready}</Tag>;
  // Required steps only: an optional step never counts toward the state.
  if (!state.total) return <Tag tone="warning">{P.notConfigured}</Tag>;
  return <Tag tone="warning">{STEPS.stepsOf(state.done, state.total)}</Tag>;
}

function SetupCards({ state }: { state: SetupScreenState }) {
  const title = P.configTitle(state.name);
  if (state.kind !== "ready")
    return (
      <SectionCard id="setup-config" title={title}>
        <Notice tone={state.kind === "unknown" ? "negative" : "warning"} className="m-0">
          {state.kind === "unknown" ? S.unknown : S.disabled}
        </Notice>
      </SectionCard>
    );
  return (
    <>
      <CopyToast notice={state.notice} />
      <SectionCard
        id="setup-config"
        title={title}
        tags={
          <>
            <StepsTag state={state} />
            {state.onFirstSteps && (
              <>
                <span className="flex-1" />
                <Button variant="link" size="lg" onPress={state.onFirstSteps}>
                  {P.firstSteps}
                </Button>
              </>
            )}
          </>
        }
      >
        {state.setupState === "ready" && (
          <Notice
            tone="positive"
            className="mt-2.5"
            action={
              <Button onPress={state.onOpenModule}>
                {state.firstTabLabel ? `${state.firstTabLabel}${ARROW}` : P.overview}
              </Button>
            }
          >
            {P.configured}
          </Notice>
        )}
        {state.steps.length ? (
          <SetupSteps
            steps={state.steps.map((step) => ({
              key: step.id,
              title: step.title,
              hint: step.description,
              status: step.status,
              optional: step.optional,
              actions: step.actions.length
                ? step.actions.map((action) => (
                    <Button
                      key={`${step.id}:${action.kind}:${action.target}:${action.label}`}
                      disabled={!action.intent}
                      title={
                        action.intent
                          ? action.intent.kind === "copy"
                            ? action.target
                            : undefined
                          : P.soon
                      }
                      onPress={() => void state.onAction(action.intent)}
                    >
                      {action.label}
                    </Button>
                  ))
                : undefined,
            }))}
          />
        ) : (
          <div className="py-2 text-sm text-fg-muted">{P.noSteps}</div>
        )}
      </SectionCard>
      {state.skill && (
        <AgentWidgetView
          agent={state.agent}
          skill={state.skill}
          skillHint={state.skillHint}
          privacy={state.mcpPrivacy}
          onCopy={(text) => void state.onAction({ kind: "copy", text })}
          onSettings={state.onAgentSettings}
        />
      )}
    </>
  );
}
