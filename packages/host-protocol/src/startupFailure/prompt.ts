// The copy-paste prompt for the user's agent, built from a validated report only. Every value it
// renders is an enum code, an integer, a boolean, the app version, the shortened build id or a
// `~`-relative path (all checked by the report schema); the surrounding text comes from the PL / EN
// catalog. It is the same text the diagnostics file holds.
import { STARTUP_FACT_KEYS, type StartupFailureCode } from "./codes.js";
import { commandPrefix } from "./command.js";
import { PROMPT, type PromptLang } from "./prompt.strings.js";
import { formatLogLine } from "./redaction.js";
import type { StartupFailureReport } from "./schema.js";

/** The migration runbook, relative to the cashU repository. */
export const MIGRATION_RUNBOOK = "docs/migration-runbook.md";

/** The catalog keys whose entries are plain texts. */
type TextKey = {
  [K in keyof typeof PROMPT]: (typeof PROMPT)[K]["pl"] extends string ? K : never;
}[keyof typeof PROMPT];

/** Codes fixed by running the import (again): it imports, or finishes an interrupted cutover. */
const IMPORT_FIXES: ReadonlySet<StartupFailureCode> = new Set([
  "python_data_present",
  "migrate_import_failed",
  "migration_incomplete",
]);

/** The shipped commands for this failure, in the form that runs on this install. */
export function recoveryCommands(report: StartupFailureReport): string[] {
  const cashu = commandPrefix(report.command);
  const verify = `${cashu} migrate verify`;
  return IMPORT_FIXES.has(report.failure.code) ? [`${cashu} migrate`, verify] : [verify];
}

/** The prompt text in `lang`, from a report that passed `startupFailureReportSchema`. */
export function buildRecoveryPrompt(report: StartupFailureReport, lang: PromptLang): string {
  const t = (key: TextKey): string => PROMPT[key][lang];
  const { failure } = report;
  const facts = STARTUP_FACT_KEYS.flatMap((key) =>
    failure.facts[key] === undefined ? [] : [`${key}=${failure.facts[key]}`],
  );
  const log = report.logTail.map((line) => `  ${formatLogLine(line)}`);
  return [
    t("intro"),
    "",
    `${t("app")}: cashU ${report.appVersion} (${t("build")} ${report.build})`,
    `${t("code")}: ${failure.code}`,
    ...(failure.detail === undefined ? [] : [`${t("detail")}: ${failure.detail}`]),
    `${t("stage")}: ${failure.stage}`,
    `${t("at")}: ${report.at}`,
    `${t("originals")}: ${failure.originalsUntouched ? t("yes") : t("notConfirmed")}`,
    `${t("facts")}: ${facts.length === 0 ? t("none") : facts.join(", ")}`,
    `${t("dataDir")}: ${report.dataDir}`,
    ...(report.reportFile === null ? [] : [`${t("reportFile")}: ${report.reportFile}`]),
    `${t("meaning")}: ${PROMPT.codeMeaning[lang](failure.code)}`,
    "",
    `${t("logTitle")}:`,
    ...(log.length === 0 ? [`  ${t("logEmpty")}`] : log),
    ...(report.omittedLogLines > 0 ? [`  ${PROMPT.omitted[lang](report.omittedLogLines)}`] : []),
    "",
    t("commandsTitle"),
    ...recoveryCommands(report).map((command) => `  ${command}`),
    IMPORT_FIXES.has(failure.code) ? t("migrateHint") : t("verifyHint"),
    `${t("runbook")}: ${MIGRATION_RUNBOOK} (${t("runbookWhere")})`,
    "",
    t("rulesTitle"),
    `- ${t("ruleCopy")}`,
    `- ${t("ruleDelete")}`,
    `- ${t("ruleSend")}`,
    `- ${t("ruleAsk")}`,
    "",
  ].join("\n");
}
