import { S } from "@cashu/i18n/loans/Start.strings";
import { L } from "./Loans.strings.js";
import type { LoansState } from "./useLoansScreen.js";

export function LoansStartView({ state }: { state: LoansState }) {
  const steps = state.setup.ok ? state.setup.value.steps : [];
  return (
    <section className="grid gap-3 rounded-lg border border-border bg-surface-raised p-6">
      <h2 className="text-title">{L.setup}</h2>
      {steps.map((step) => (
        <div
          key={step.id}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3"
        >
          <div>
            <h3>
              {step.title} · {step.status === "done" ? L.ready : L.notReady}
            </h3>
            <p className="text-caption text-fg-muted">{step.description}</p>
          </div>
          {step.id === "loan" ? (
            <button type="button" disabled={state.busy || state.privacy} onClick={state.openLoan}>
              {state.rows.length ? S.addAnother : S.addLoan}
            </button>
          ) : (
            <button
              type="button"
              disabled={state.busy || state.privacy || state.rows.length === 0}
              onClick={state.openPayment}
            >
              {S.pick}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
