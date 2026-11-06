import { Button, Card } from "@cashu/ui";
import {
  type RecoveryCode,
  type RecoveryStage,
  type RecoveryUnpriced,
  S,
} from "./Recovery.strings.js";

export type RecoveryNotice = "copied" | "copyFailed" | "openFailed";

/** "Import my data" as the view sees it. */
export interface ImportView {
  /** `import` (Python data present), `finish` (an interrupted cutover), or null (not offered). */
  readonly kind: "import" | "finish" | null;
  readonly phase: "idle" | "starting" | "running" | "words" | "cancelling" | "done";
  /** Every stage in order with its state; empty until main reports the first one. */
  readonly stages: readonly ImportStageView[];
  /** The one-time recovery words while they wait for the user, else null. */
  readonly words: string | null;
  readonly wordsConfirmed: boolean;
  readonly notice: "refused" | "cancelled" | null;
  /** After a finished import (`done`): the imported instruments the app cannot value yet. */
  readonly unpriced: readonly RecoveryUnpriced[];
}

export interface ImportStageView {
  readonly stage: RecoveryStage;
  readonly status: "done" | "running" | null;
}

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
  /** An import runs (Retry waits for it). */
  readonly importing: boolean;
  readonly import: ImportView;
  readonly onImport: () => void;
  readonly onWordsConfirmed: (confirmed: boolean) => void;
  readonly onContinueImport: () => void;
  readonly onCancelImport: () => void;
  readonly onCopy: () => void;
  readonly onOpenFolder: () => void;
  readonly onRetry: () => void;
  readonly onQuit: () => void;
}

const NOTICE: Record<RecoveryNotice, () => string> = {
  copied: () => S.copied,
  copyFailed: () => S.copyFailed,
  openFailed: () => S.openFailed,
};

function ImportSection({
  state,
  canAct,
  busy,
  onImport,
  onWordsConfirmed,
  onContinueImport,
  onCancelImport,
  onOpenApp,
}: {
  state: ImportView;
  canAct: boolean;
  busy: boolean;
  onImport: () => void;
  onWordsConfirmed: (confirmed: boolean) => void;
  onContinueImport: () => void;
  onCancelImport: () => void;
  onOpenApp: () => void;
}) {
  const showStages =
    state.stages.length > 0 && (state.phase === "running" || state.phase === "words");
  return (
    <Card as="section" padding="lg" labelledBy="recovery-import">
      <h2 id="recovery-import" className="text-title font-strong">
        {S.importTitle}
      </h2>
      <p className="mt-3">{S.importHint}</p>
      {state.phase === "idle" && (
        <div className="mt-4">
          <Button variant="primary" onPress={onImport} disabled={!canAct}>
            {state.kind === "finish" ? S.finishImport : S.importData}
          </Button>
        </div>
      )}
      {showStages && (
        <ol className="mt-4 grid gap-1" data-testid="recovery-import-stages">
          {state.stages.map(({ stage, status }) => {
            return (
              <li
                key={stage}
                aria-current={status === "running" ? "step" : undefined}
                className={status === null ? "text-fg-muted" : undefined}
              >
                {S.stageLabel(stage)}
                {status === "done" && ` (${S.stageDone})`}
                {status === "running" && ` (${S.stageRunning})`}
              </li>
            );
          })}
        </ol>
      )}
      {state.words !== null && (
        <div className="mt-4 grid gap-4">
          <h3 className="text-body font-strong">{S.wordsTitle}</h3>
          <p>{S.wordsHint}</p>
          <p
            className="rounded-sm border border-border bg-surface p-4 font-mono leading-loose"
            data-testid="migration-recovery-phrase"
          >
            {state.words}
          </p>
          <label className="flex gap-3">
            <input
              type="checkbox"
              checked={state.wordsConfirmed}
              onChange={(event) => onWordsConfirmed(event.target.checked)}
            />
            {S.wordsConfirmed}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!state.wordsConfirmed} onPress={onContinueImport}>
              {S.wordsContinue}
            </Button>
            <Button variant="ghost" onPress={onCancelImport}>
              {S.wordsCancel}
            </Button>
          </div>
        </div>
      )}
      {state.phase === "done" && (
        <div className="mt-4 grid gap-4">
          <p>{S.unpricedHint}</p>
          <ul className="grid gap-1" data-testid="recovery-unpriced">
            {state.unpriced.map((item) => (
              <li key={`${item.label} ${item.currency}`}>{S.unpricedItem(item)}</li>
            ))}
          </ul>
          <div>
            <Button variant="primary" onPress={onOpenApp} disabled={busy || !canAct}>
              {S.openApp}
            </Button>
          </div>
        </div>
      )}
      <p role="status" className="mt-3 text-fg-muted">
        {state.phase === "done"
          ? S.importDone
          : state.phase === "starting"
            ? S.importStarting
            : state.phase === "cancelling"
              ? S.importCancelling
              : state.notice === "refused"
                ? S.importRefused
                : state.notice === "cancelled"
                  ? S.importCancelled
                  : ""}
      </p>
    </Card>
  );
}

/** Start-up recovery: what happened, why the data is safe, and what to do next. No host needed. */
export function RecoveryView({
  details,
  prompt,
  notice,
  busy,
  canAct,
  importing,
  import: importState,
  onImport,
  onWordsConfirmed,
  onContinueImport,
  onCancelImport,
  onCopy,
  onOpenFolder,
  onRetry,
  onQuit,
}: RecoveryViewProps) {
  const offersImport = details !== null && importState.kind !== null;
  return (
    <main className="min-h-screen bg-surface p-6 text-body text-fg">
      <h1 className="text-headline font-strong">cashU</h1>
      <div className="mt-6 flex max-w-2xl flex-col gap-4">
        <Card as="section" padding="lg" labelledBy="recovery-title">
          <h2 id="recovery-title" className="text-title font-strong">
            {S.title}
          </h2>
          <p role="alert" className="mt-3">
            {details === null ? S.unavailable : S.what(details.code)}
          </p>
        </Card>
        {offersImport && (
          <ImportSection
            state={importState}
            canAct={canAct}
            busy={busy}
            onImport={onImport}
            onWordsConfirmed={onWordsConfirmed}
            onContinueImport={onContinueImport}
            onCancelImport={onCancelImport}
            onOpenApp={onRetry}
          />
        )}
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
              <Button
                variant={offersImport ? "secondary" : "primary"}
                onPress={onCopy}
                disabled={busy || !canAct}
              >
                {S.copy}
              </Button>
            )}
            <Button onPress={onOpenFolder} disabled={busy || !canAct}>
              {S.openFolder}
            </Button>
            <Button onPress={onRetry} disabled={busy || importing || !canAct}>
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
