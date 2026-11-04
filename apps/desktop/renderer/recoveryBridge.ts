// The recovery screen's bridge to Electron main (preload `cashuRecovery`). It works while the host
// is down: main owns the report, the clipboard, the data folder, the import child and the start
// sequence. The page never passes a path or a text to main; it sends only the prompt language and
// the word confirmation. What main returns or pushes is parsed again here (main validated it already;
// the page trusts neither side's types blindly).
import {
  type PromptLang,
  parseStartupFailureReport,
  type RecoveryImportEvent,
  recoveryImportEventSchema,
  type StartupFailureReport,
} from "@cashu/host-protocol/startup-failure";

interface RecoveryBridgeApi {
  report(): Promise<unknown>;
  copyPrompt(lang: PromptLang): Promise<unknown>;
  openDataFolder(): Promise<unknown>;
  retry(): Promise<unknown>;
  quit(): Promise<unknown>;
  importData(): Promise<unknown>;
  confirmWords(confirmed: boolean): Promise<unknown>;
  onImportEvent(handler: (event: unknown) => void): () => void;
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
  quit(): Promise<void>;
  /** Starts "Import my data"; false when main refused (one already runs, or nothing to import). */
  importData(): Promise<boolean>;
  /** Answers the recovery words: true = written down, false = cancel the import. */
  confirmWords(confirmed: boolean): Promise<boolean>;
  /** Import events from main (invalid ones are dropped); returns the unsubscribe. */
  onImportEvent(handler: (event: RecoveryImportEvent) => void): () => void;
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
    async quit() {
      await api.quit().catch(() => {});
    },
    importData: () => flag(() => api.importData()),
    confirmWords: (confirmed) => flag(() => api.confirmWords(confirmed)),
    onImportEvent(handler) {
      return api.onImportEvent((raw) => {
        const event = recoveryImportEventSchema.safeParse(raw);
        if (event.success) handler(event.data);
      });
    },
  };
}
