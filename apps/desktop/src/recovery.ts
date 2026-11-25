/// <reference types="node" />
// Electron main's start-up recovery state (T54). Main enters recovery when its own admission finds
// the old (Python) app's data and no native profile yet (python_data_present: the screen offers the
// agent prompt and a way on to first-run setup), or when the host it started recorded a typed failure
// (`<data dir>/diagnostics/startup-failure.json`). Each new failure gets a report pair in `<data dir>/diagnostics/` (the validated report and the agent
// prompt, 0600 in a 0700 dir, never deleted). The renderer's recovery screen reads the report over IPC;
// main builds the prompt itself, so the page never hands main a text or a path.
import {
  buildRecoveryPrompt,
  type PromptLang,
  type RecoveryCommand,
  type StartupFailure,
  type StartupFailureReport,
  startupFailure,
  startupFailureReport,
} from "@cashu/host-protocol/startup-failure";
import {
  type FoundStartupFailure,
  readHostLogTail,
  startupReportPaths,
  writeStartupFailureReport,
} from "@cashu/node-host";

export interface StartupRecoveryDeps {
  readonly dataDir: string;
  readonly home: string;
  readonly appVersion: string;
  readonly build: string;
  /** The language of the prompt file written beside the report (main's language). */
  readonly lang: PromptLang;
  /** `<data dir>/logs/host.log`; only its allow-listed lines reach the report. */
  readonly hostLogPath: string;
  /** The `cashu` command form of this install, computed when a report is built. */
  command(): RecoveryCommand | null;
  /** This flavor's MCP server name prefix (`cashu`, `cashu-staging`), as the setup screen uses it. */
  readonly mcpServerPrefix: string;
  /** Value-free lines for the shell's log. */
  log(line: string): void;
}

/** What main's own admission found: roots holding old app data, and whether a native profile exists. */
export interface OldAppData {
  /** How many of the admission roots hold the old (Python) app's database. */
  readonly roots: number;
  /** The data dir already has native vaults (the old data was dealt with or set aside). */
  readonly nativeInventory: boolean;
  /** The user chose to continue to first-run setup without the old data (this run only). */
  readonly continued: boolean;
}

/** Main's own admission as a failure (null: nothing to show; the start goes on as usual). */
export function admissionFailure(found: OldAppData): StartupFailure | null {
  if (found.roots === 0 || found.nativeInventory || found.continued) return null;
  return startupFailure("python_data_present", "python_data_found", { pythonSources: found.roots });
}

function sameFailure(a: StartupFailure, b: StartupFailure): boolean {
  return a.code === b.code && a.detail === b.detail;
}

interface Current {
  readonly failure: StartupFailure;
  readonly report: StartupFailureReport;
  /** The host record it came from (its time), so a record seen twice is entered once. */
  readonly recordAt: number | null;
}

export class StartupRecovery {
  readonly #deps: StartupRecoveryDeps;
  #current: Current | null = null;

  constructor(deps: StartupRecoveryDeps) {
    this.#deps = deps;
  }

  get active(): boolean {
    return this.#current !== null;
  }

  get failure(): StartupFailure | null {
    return this.#current?.failure ?? null;
  }

  /** The validated report the recovery screen shows, or null when not recovering. */
  get report(): StartupFailureReport | null {
    return this.#current?.report ?? null;
  }

  /** The agent prompt in `lang` (what Copy puts on the clipboard), or null when not recovering. */
  prompt(lang: PromptLang): string | null {
    const report = this.report;
    return report === null ? null : buildRecoveryPrompt(report, lang);
  }

  /** Enters recovery for `failure` and writes its report pair. */
  enter(failure: StartupFailure, at: Date, recordAt: number | null = null): StartupFailureReport {
    const deps = this.#deps;
    const context = {
      failure,
      at,
      appVersion: deps.appVersion,
      build: deps.build,
      dataDir: deps.dataDir,
      home: deps.home,
      logText: readHostLogTail(deps.hostLogPath),
      command: deps.command(),
      mcpServerPrefix: deps.mcpServerPrefix,
    };
    let report: StartupFailureReport;
    try {
      const paths = startupReportPaths(deps.dataDir, at);
      report = startupFailureReport({ ...context, reportFile: paths.text });
      writeStartupFailureReport(paths, report, buildRecoveryPrompt(report, deps.lang));
    } catch {
      deps.log("recovery: the diagnostics report could not be written");
      report = startupFailureReport({ ...context, reportFile: null });
    }
    this.#current = { failure: report.failure, report, recordAt };
    deps.log(`recovery: ${report.failure.code} at ${report.failure.stage}`);
    return report;
  }

  /**
   * A failure record the host wrote while main waited for it. Returns whether it is new (the same
   * record seen by a second waiting client is entered once).
   */
  hostFailure(found: FoundStartupFailure): boolean {
    if (this.#current !== null && this.#current.recordAt === found.at) return false;
    this.enter(found.failure, new Date(found.at), found.at);
    return true;
  }

  /**
   * Re-checks main's own admission (start, and Retry on the screen): old app data without a native
   * profile keeps or enters recovery (the same failure keeps its report, no new files); otherwise it
   * clears it. Returns whether main is recovering afterwards.
   */
  admit(found: OldAppData, at: Date): boolean {
    const failure = admissionFailure(found);
    if (failure === null) {
      this.#current = null;
      return false;
    }
    if (this.#current === null || !sameFailure(this.#current.failure, failure))
      this.enter(failure, at);
    return true;
  }

  /** Leaves recovery (Continue on the old-data screen). */
  clear(): void {
    this.#current = null;
  }
}
