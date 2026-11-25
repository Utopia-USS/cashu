// Screen hook of the start-up recovery screen: the prompt preview in the UI language and the actions
// over the main-process bridge (for the old app's data also Continue, on to first-run setup). Works
// without the host (it never touches the store).
import {
  buildRecoveryPrompt,
  type StartupFailureReport,
} from "@cashu/host-protocol/startup-failure";
import { lang } from "@cashu/i18n";
import { useState } from "react";
import type { RecoveryBridge } from "../recoveryBridge.js";
import type { RecoveryDetails, RecoveryNotice, RecoveryViewProps } from "./RecoveryView.js";

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

export function useRecoveryScreen(
  report: StartupFailureReport | null,
  bridge: RecoveryBridge | null,
): RecoveryViewProps {
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<RecoveryNotice | null>) => {
    if (busy) return;
    setBusy(true);
    try {
      setNotice(await action());
    } finally {
      setBusy(false);
    }
  };

  return {
    details: recoveryDetails(report),
    prompt: report === null ? null : buildRecoveryPrompt(report, lang()),
    notice,
    busy,
    canAct: bridge !== null,
    onCopy: () =>
      run(async () =>
        report !== null && (await bridge?.copyPrompt(lang())) ? "copied" : "copyFailed",
      ),
    onOpenFolder: () => run(async () => ((await bridge?.openDataFolder()) ? null : "openFailed")),
    onRetry: () =>
      run(async () => {
        await bridge?.retry();
        return null;
      }),
    onContinueWithoutOldData: () =>
      run(async () => {
        await bridge?.continueWithoutOldData();
        return null;
      }),
    onQuit: () =>
      run(async () => {
        await bridge?.quit();
        return null;
      }),
  };
}
