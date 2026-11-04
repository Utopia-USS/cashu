import { S } from "./Admission.strings.js";

export interface AdmissionViewProps {
  readonly status: "migration_required" | "migration_pending" | "refused";
  readonly onRetry: () => void;
}

/** A refusal-only screen. It cannot create a vault or launch the Python UI. */
export function AdmissionView({ status, onRetry }: AdmissionViewProps) {
  const explanation =
    status === "migration_required"
      ? S.migrationRequired
      : status === "migration_pending"
        ? S.migrationPending
        : S.refused;
  return (
    <main className="min-h-screen bg-surface p-6 text-body text-fg">
      <h1 className="text-headline font-strong">cashU</h1>
      <section aria-labelledby="admission-title" className="mt-8 max-w-xl">
        <h2 id="admission-title" className="text-title font-strong">
          {S.title}
        </h2>
        <p role="alert" className="mt-3 text-fg-muted">
          {explanation}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 rounded-sm border border-border bg-surface-raised px-4 py-2"
        >
          {S.retry}
        </button>
      </section>
    </main>
  );
}
