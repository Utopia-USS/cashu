import { Button, Card } from "@cashu/ui";
import { type RecoveryCode, S } from "./Recovery.strings.js";

export type RecoveryNotice = "copied" | "copyFailed" | "openFailed";

/** What the screen shows of the validated report (codes, `~` paths). */
export interface RecoveryDetails {
  readonly code: RecoveryCode;
  readonly detail: string | null;
  readonly stage: string;
  readonly originalsUntouched: boolean;
  readonly dataDir: string;
  readonly reportFile: string | null;
}

export interface RecoveryViewProps {
  /** From the validated failure report, or null when main had none to give. */
  readonly details: RecoveryDetails | null;
  /** The agent prompt in the UI language (exactly what Copy puts on the clipboard). */
  readonly prompt: string | null;
  readonly notice: RecoveryNotice | null;
  /** An action is running. */
  readonly busy: boolean;
  /** The main-process bridge is present. */
  readonly canAct: boolean;
  /** Each action resolves when main has answered (its button shows a spinner until then). */
  readonly onCopy: () => Promise<void>;
  readonly onOpenFolder: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
  /** Old app data only: go on to first-run setup without it. */
  readonly onContinueWithoutOldData: () => Promise<void>;
  readonly onQuit: () => Promise<void>;
}

const NOTICE: Record<RecoveryNotice, () => string> = {
  copied: () => S.copied,
  copyFailed: () => S.copyFailed,
  openFailed: () => S.openFailed,
};

/** Start-up recovery: what happened, why the data is safe, and what to do next. No host needed. */
export function RecoveryView({
  details,
  prompt,
  notice,
  busy,
  canAct,
  onCopy,
  onOpenFolder,
  onRetry,
  onContinueWithoutOldData,
  onQuit,
}: RecoveryViewProps) {
  // The old app's data is no failure: the app can start, the screen offers the agent prompt first.
  const oldData = details?.code === "python_data_present";
  return (
    <main className="min-h-screen bg-surface p-6 text-body text-fg">
      <h1 className="text-headline font-strong">cashU</h1>
      <div className="mt-6 flex max-w-2xl flex-col gap-4">
        <Card as="section" padding="lg" labelledBy="recovery-title">
          <h2 id="recovery-title" className="text-title font-strong">
            {oldData ? S.oldDataTitle : S.title}
          </h2>
          <p role="alert" className="mt-3">
            {details === null ? S.unavailable : S.what(details.code)}
          </p>
        </Card>
        {details !== null && (
          <Card as="section" padding="lg" labelledBy="recovery-safe">
            <h2 id="recovery-safe" className="text-title font-strong">
              {S.safeTitle}
            </h2>
            <p className="mt-3">{details.originalsUntouched ? S.untouched : S.notConfirmed}</p>
            {details.originalsUntouched && <p className="mt-2">{S.safe(details.code)}</p>}
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
              <dt className="text-fg-muted">{S.dataDir}</dt>
              <dd data-testid="recovery-data-dir">
                <code>{details.dataDir}</code>
              </dd>
              <dt className="text-fg-muted">{S.report}</dt>
              <dd data-testid="recovery-report-file">
                {details.reportFile === null ? S.reportMissing : <code>{details.reportFile}</code>}
              </dd>
              <dt className="text-fg-muted">{S.code}</dt>
              <dd>
                <code data-testid="recovery-code">{details.code}</code>
                {details.detail === null ? null : <code> ({details.detail})</code>}
              </dd>
              <dt className="text-fg-muted">{S.stage}</dt>
              <dd>
                <code>{details.stage}</code>
              </dd>
            </dl>
          </Card>
        )}
        <Card as="section" padding="lg" labelledBy="recovery-next">
          <h2 id="recovery-next" className="text-title font-strong">
            {S.nextTitle}
          </h2>
          {prompt !== null && <p className="mt-3">{S.next}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {prompt !== null && (
              <Button variant="primary" onPress={onCopy} disabled={busy || !canAct}>
                {S.copy}
              </Button>
            )}
            {oldData && (
              <Button onPress={onContinueWithoutOldData} disabled={busy || !canAct}>
                {S.continueWithoutOldData}
              </Button>
            )}
            <Button onPress={onOpenFolder} disabled={busy || !canAct}>
              {S.openFolder}
            </Button>
            <Button onPress={onRetry} disabled={busy || !canAct}>
              {S.retry}
            </Button>
            <Button variant="ghost" onPress={onQuit} disabled={busy || !canAct}>
              {S.quit}
            </Button>
          </div>
          <p role="status" className="mt-3 text-fg-muted">
            {notice === null ? "" : NOTICE[notice]()}
          </p>
          {prompt !== null && (
            <details className="mt-4">
              <summary className="cursor-pointer">{S.showPrompt}</summary>
              <pre
                data-testid="recovery-prompt"
                className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-sm border border-border bg-surface-sunken p-3 text-caption"
              >
                {prompt}
              </pre>
            </details>
          )}
        </Card>
      </div>
    </main>
  );
}
