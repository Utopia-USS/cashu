import type { ResearchInputs } from "@cashu/store/investments/research-screen";
import { S } from "./Research.strings.js";
import type { TopicFormValues } from "./types.js";

type TopicRecord = ResearchInputs["topics"][number]["thesis"];
type Outcome = { ok: boolean; reason?: string };

/** Two owner commands, with a fresh scope check before the second write and every notice. */
export async function saveTopicSequence(args: {
  topic: string;
  record: TopicRecord;
  value: TopicFormValues;
  current(): boolean;
  saveThesis(input: { segment: string; thesis: string; invalidation: string }): Promise<Outcome>;
  deleteThesis(input: { segment: string }): Promise<Outcome>;
  setView(input: {
    segment: string;
    assessment: string;
    outlook: string;
    by: "owner";
    sources?: readonly unknown[];
  }): Promise<Outcome>;
  notice(message: string): void;
  saved(): void;
}) {
  const { topic, record, value, current, notice } = args;
  if (!current()) return;
  const thesis = value.thesis.trim();
  const changedThesis =
    thesis !== (record?.thesis ?? "") ||
    value.invalidation.trim() !== (record?.invalidation ?? "") ||
    (record?.draft === true && value.confirmDraft && thesis !== "");
  if (record?.draft && changedThesis && thesis !== "" && !value.confirmDraft) {
    notice(S.confirmDraft);
    return;
  }
  const changedView =
    value.assessment.trim() !== (record?.assessment ?? "") ||
    value.outlook.trim() !== (record?.outlook ?? "") ||
    value.clearSources;
  if (!changedThesis && !changedView) {
    notice(S.noChanges);
    return;
  }
  let firstSaved = false;
  if (changedThesis) {
    try {
      const first = thesis
        ? await args.saveThesis({ segment: topic, thesis, invalidation: value.invalidation })
        : await args.deleteThesis({ segment: topic });
      if (!current()) return;
      if (!first.ok) {
        notice(`${S.refused}: ${first.reason ?? ""}`);
        return;
      }
      firstSaved = true;
    } catch {
      if (current()) notice(S.unknown);
      return;
    }
  }
  if (changedView && thesis) {
    if (!current()) return;
    try {
      const second = await args.setView({
        segment: topic,
        assessment: value.assessment,
        outlook: value.outlook,
        by: "owner",
        ...(value.clearSources ? { sources: [] } : {}),
      });
      if (!current()) return;
      if (!second.ok) {
        notice(firstSaved ? S.partialSave : `${S.refused}: ${second.reason ?? ""}`);
        return;
      }
    } catch {
      if (current()) notice(firstSaved ? S.partialSave : S.unknown);
      return;
    }
  }
  if (current()) {
    args.saved();
    notice(S.saved);
  }
}
