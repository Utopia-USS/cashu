// The recovery screen's bridge to Electron main (preload `cashuRecovery`). It works while the host
// is down: main owns the report, the clipboard, the data folder and the start sequence. The page never
// passes a path or a text to main; it sends only the prompt language. What main returns is parsed
// again here (main validated it already; the page trusts neither side's types blindly).
import {
  type PromptLang,
  parseStartupFailureReport,
  type StartupFailureReport,
} from "@cashu/host-protocol/startup-failure";

interface RecoveryBridgeApi {
  report(): Promise<unknown>;
  copyPrompt(lang: PromptLang): Promise<unknown>;
  openDataFolder(): Promise<unknown>;
  retry(): Promise<unknown>;
  continueWithoutOldData(): Promise<unknown>;
  quit(): Promise<unknown>;
}

declare global {
  interface Window {
    readonly cashuRecovery?: RecoveryBridgeApi;
  }
}

export interface RecoveryBridge {
  copyPrompt(lang: PromptLang): Promise<boolean>;
  openDataFolder(): Promise<boolean>;
  retry(): Promise<void>;
  /** Old app data screen: go on to first-run setup, the old data stays untouched. */
  continueWithoutOldData(): Promise<void>;
  quit(): Promise<void>;
}

/** The validated report main holds, or null (no bridge, no failure, or an invalid value). */
export async function readRecoveryReport(): Promise<StartupFailureReport | null> {
  try {
    return parseStartupFailureReport(await window.cashuRecovery?.report());
  } catch {
    return null;
  }
}

export function recoveryBridge(): RecoveryBridge | null {
  const api = window.cashuRecovery;
  if (!api) return null;
  const flag = async (call: () => Promise<unknown>) => {
    try {
      return (await call()) === true;
    } catch {
      return false;
    }
  };
  return {
    copyPrompt: (lang) => flag(() => api.copyPrompt(lang)),
    openDataFolder: () => flag(() => api.openDataFolder()),
    async retry() {
      await api.retry().catch(() => {});
    },
    async continueWithoutOldData() {
      await api.continueWithoutOldData().catch(() => {});
    },
    async quit() {
      await api.quit().catch(() => {});
    },
  };
}
