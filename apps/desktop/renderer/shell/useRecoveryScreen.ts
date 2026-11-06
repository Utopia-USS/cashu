// Screen hook of the start-up recovery screen: the prompt preview in the UI language, the actions
// over the main-process bridge, and "Import my data" (progress from main, the one-time recovery
// words, the instruments a finished import cannot value). Works without the host (it never touches
// the store). The words live only in this state while they are shown and are cleared the moment the
// user continues or cancels.
import {
  buildRecoveryPrompt,
  MIGRATE_STAGES,
  type MigrateStage,
  type StartupFailureCode,
  type StartupFailureReport,
  type UnpricedInstrument,
} from "@cashu/host-protocol/startup-failure";
import { lang } from "@cashu/i18n";
import { useEffect, useState } from "react";
import type { RecoveryBridge } from "../recoveryBridge.js";
import type {
  ImportStageView,
  ImportView,
  RecoveryDetails,
  RecoveryNotice,
  RecoveryViewProps,
} from "./RecoveryView.js";

/** What "Import my data" offers for a failure: an import, finishing one, or nothing. */
function importKind(code: StartupFailureCode | undefined): ImportView["kind"] {
  if (code === "python_data_present") return "import";
  if (code === "migration_incomplete") return "finish";
  return null;
}

/** What the screen shows of a validated report (null: none). */
export function recoveryDetails(report: StartupFailureReport | null): RecoveryDetails | null {
  if (report === null) return null;
  const { failure } = report;
  return {
    code: failure.code,
    detail: failure.detail ?? null,
    stage: failure.stage,
    originalsUntouched: failure.originalsUntouched,
    dataDir: report.dataDir,
    reportFile: report.reportFile,
  };
}

/** Every import stage with its state, given the last one main reported (none: empty). */
export function importStages(current: MigrateStage | null): ImportStageView[] {
  if (current === null) return [];
  const at = MIGRATE_STAGES.indexOf(current);
  return MIGRATE_STAGES.map((stage, index) => ({
    stage,
    status: index < at ? "done" : index === at ? "running" : null,
  }));
}

type ImportState =
  | { readonly phase: "idle"; readonly notice: "refused" | "cancelled" | null }
  | { readonly phase: "starting" | "cancelling" }
  | { readonly phase: "running"; readonly stage: MigrateStage | null }
  | {
      readonly phase: "words";
      readonly stage: MigrateStage | null;
      readonly words: string;
      readonly confirmed: boolean;
    }
  | { readonly phase: "done"; readonly unpriced: readonly UnpricedInstrument[] };

const IDLE: ImportState = { phase: "idle", notice: null };

function stageOf(state: ImportState): MigrateStage | null {
  return state.phase === "running" || state.phase === "words" ? state.stage : null;
}

export function useRecoveryScreen(
  report: StartupFailureReport | null,
  bridge: RecoveryBridge | null,
): RecoveryViewProps {
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<ImportState>(IDLE);

  useEffect(
    () =>
      bridge?.onImportEvent((event) => {
        if (event.kind === "progress") setImported({ phase: "running", stage: event.stage });
        else if (event.kind === "words")
          setImported((state) => ({
            phase: "words",
            stage: stageOf(state),
            words: event.words,
            confirmed: false,
          }));
        else if (event.kind === "done") setImported({ phase: "done", unpriced: event.unpriced });
        else setImported({ phase: "idle", notice: "cancelled" });
      }),
    [bridge],
  );

  const importing = imported.phase !== "idle" && imported.phase !== "done";
  const run = async (action: () => Promise<RecoveryNotice | null>) => {
    if (busy) return;
    setBusy(true);
    try {
      setNotice(await action());
    } finally {
      setBusy(false);
    }
  };
  const answerWords = (confirmed: boolean) => {
    if (imported.phase !== "words" || (confirmed && !imported.confirmed)) return;
    // The words leave the state before main hears the answer.
    setImported(confirmed ? { phase: "running", stage: imported.stage } : { phase: "cancelling" });
    void bridge?.confirmWords(confirmed);
  };
  const kind = importKind(report?.failure.code);

  return {
    details: recoveryDetails(report),
    prompt: report === null ? null : buildRecoveryPrompt(report, lang()),
    notice,
    busy,
    canAct: bridge !== null,
    importing,
    import: {
      kind,
      phase: imported.phase,
      stages: importStages(stageOf(imported)),
      words: imported.phase === "words" ? imported.words : null,
      wordsConfirmed: imported.phase === "words" && imported.confirmed,
      notice: imported.phase === "idle" ? imported.notice : null,
      unpriced: imported.phase === "done" ? imported.unpriced : [],
    },
    onImport: () => {
      if (kind === null || importing || bridge === null) return;
      setImported({ phase: "starting" });
      void bridge.importData().then((started) => {
        if (!started) setImported({ phase: "idle", notice: "refused" });
      });
    },
    onWordsConfirmed: (confirmed) =>
      setImported((state) => (state.phase === "words" ? { ...state, confirmed } : state)),
    onContinueImport: () => answerWords(true),
    onCancelImport: () => answerWords(false),
    onCopy: () =>
      void run(async () =>
        report !== null && (await bridge?.copyPrompt(lang())) ? "copied" : "copyFailed",
      ),
    onOpenFolder: () =>
      void run(async () => ((await bridge?.openDataFolder()) ? null : "openFailed")),
    onRetry: () =>
      void run(async () => {
        await bridge?.retry();
        return null;
      }),
    onQuit: () =>
      void run(async () => {
        await bridge?.quit();
        return null;
      }),
  };
}
