import { S } from "../Desktop.strings.js";

export interface BootstrapViewProps {
  phase: "waiting" | "failed";
  status?: string;
  onRetried(): void;
}

export function BootstrapView({ phase, status, onRetried }: BootstrapViewProps) {
  return (
    <main className="min-h-screen bg-surface p-6 text-body text-fg">
      <h1 className="text-headline font-strong">cashU</h1>
      <p role={phase === "failed" ? "alert" : "status"} className="mt-4">
        {phase === "failed" ? S.failed : (status ?? S.waiting)}
      </p>
      <button
        type="button"
        onClick={onRetried}
        className="mt-4 rounded-sm border border-border bg-surface-raised px-4 py-2"
      >
        {S.retry}
      </button>
    </main>
  );
}
