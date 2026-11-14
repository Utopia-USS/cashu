// The copy-paste prompt for the user's agent, built from a validated report only. Every value it
// renders is an enum code, an integer, a boolean, the app version, the shortened build id or a
// `~`-relative path (all checked by the report schema); the surrounding text comes from the PL / EN
// catalog. It is the same text the diagnostics file holds.
import { STARTUP_FACT_KEYS } from "./codes.js";
import { commandPrefix } from "./command.js";
import { PROMPT, type PromptLang } from "./prompt.strings.js";
import { formatLogLine } from "./redaction.js";
import type { StartupFailureReport } from "./schema.js";

/** The catalog keys whose entries are plain texts. */
type TextKey = {
  [K in keyof typeof PROMPT]: (typeof PROMPT)[K]["pl"] extends string ? K : never;
}[keyof typeof PROMPT];

/**
 * The steps that bring the old (Python) app's data over through the app's own import paths, done by
 * the agent: the app has no import of its own for it.
 */
function oldDataSteps(report: StartupFailureReport, lang: PromptLang): string[] {
  const t = (key: TextKey): string => PROMPT[key][lang];
  const mcp = `claude mcp add ${report.mcpServerPrefix}-<slug> -- ${commandPrefix(report.command)} mcp --profile <slug>`;
  return [
    "",
    t("oldDataTitle"),
    `1. ${PROMPT.oldDataSetup[lang](mcp)}`,
    `2. ${t("oldDataSkill")}`,
    `3. ${t("oldDataBlind")}`,
    `4. ${t("oldDataConvert")}`,
    `5. ${t("oldDataRest")}`,
  ];
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
    failure.code === "python_data_present" ? t("introOldData") : t("intro"),
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
    ...(failure.code === "python_data_present" ? oldDataSteps(report, lang) : []),
    "",
    t("rulesTitle"),
    `- ${t("ruleCopy")}`,
    `- ${t("ruleDelete")}`,
    `- ${t("ruleSend")}`,
    `- ${t("ruleAsk")}`,
    "",
  ].join("\n");
}
