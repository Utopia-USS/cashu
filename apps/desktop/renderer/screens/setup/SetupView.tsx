import { AgentWidgetView } from "./AgentWidgetView.js";
import { S } from "./Setup.strings.js";
import type { SetupScreenState } from "./useSetupScreen.js";

export function SetupView({ state }: { state: SetupScreenState }) {
  if (state.kind === "unknown")
    return (
      <main className="p-6" role="alert">
        {S.unknown}
      </main>
    );
  if (state.kind === "disabled")
    return (
      <main className="p-6" role="status">
        {S.disabled}
      </main>
    );
  return (
    <main className="mx-auto grid max-w-4xl gap-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-headline font-strong">{S.title(state.name)}</h1>
          <p className="text-caption text-fg-muted">
            {state.setupState === "ready" ? S.ready : S.partial(state.done, state.total)}
          </p>
        </div>
        {state.setupState === "ready" && (
          <button type="button" onClick={state.onOpenModule}>
            {S.openModule}
          </button>
        )}
      </header>
      <section className="grid gap-3 rounded-lg border border-border bg-surface-raised p-6">
        {state.steps.length === 0 && <p>{S.noSteps}</p>}
        {state.steps.map((step) => (
          <div key={step.id} className="grid gap-2 border-t border-border py-3 first:border-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-strong">{step.title}</h2>
              <span className="text-caption text-fg-muted">
                {step.optional
                  ? S.optional
                  : step.status === "done"
                    ? S.done
                    : step.status === "on"
                      ? S.current
                      : S.later}
              </span>
            </div>
            <p className="text-fg-muted">{step.description}</p>
            <div className="flex flex-wrap gap-2">
              {step.actions.map((action) => (
                <button
                  key={`${step.id}:${action.kind}:${action.target}:${action.label}`}
                  type="button"
                  disabled={!action.intent}
                  title={action.intent ? undefined : S.unavailableAction}
                  onClick={() => void state.onAction(action.intent)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
      <AgentWidgetView
        agent={state.agent}
        skill={state.skill}
        privacy={state.mcpPrivacy}
        onCopy={(text) => void state.onAction({ kind: "copy", text })}
        onSettings={state.onAgentSettings}
      />
      {state.notice && <p role="status">{state.notice}</p>}
    </main>
  );
}
