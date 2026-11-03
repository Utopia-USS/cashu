import { research } from "@cashu/domain/investments";
import { lang } from "@cashu/i18n";
import {
  researchScreenCommands,
  researchScreenQueries,
} from "@cashu/store/investments/research-screen";
import { useCommand, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useState } from "react";
import {
  researchCalendarModel,
  researchDisplayDay,
  researchHeldModel,
  researchNoteDates,
  researchNoteFacts,
  researchNoteGroups,
  researchRunScope,
  researchScopeModel,
  researchTopicModel,
  researchTopicsModel,
} from "./presentation.js";
import { S } from "./Research.strings.js";
import { useResearchTopicForm } from "./useResearchTopicForm.js";

const queries = researchScreenQueries();
const commands = researchScreenCommands();
export type ResearchTab = "topics" | "mine" | "notes" | "calendar" | "candidates" | "runs";
export const RESEARCH_TABS: readonly ResearchTab[] = [
  "topics",
  "mine",
  "notes",
  "calendar",
  "candidates",
  "runs",
];

export interface ResearchScreenOptions {
  readonly today: string;
  readonly initialTab?: string;
  readonly initialTopic?: string | null;
  readonly initialNote?: string | null;
  onBack(): void;
  onOpenAsset(instrument: string, note?: string): void;
  onSettings(): void;
  copyCommand(text: string): Promise<void>;
}

export function useResearchScreen(options: ResearchScreenOptions) {
  const { privacy } = useUiEnv();
  const [tab, setTab] = useState<ResearchTab>(
    RESEARCH_TABS.includes(options.initialTab as ResearchTab)
      ? (options.initialTab as ResearchTab)
      : options.initialTab === "scope=candidates"
        ? "candidates"
        : "topics",
  );
  const [topic, setTopic] = useState<string | null>(
    options.initialTopic && research.isNoteSegment(options.initialTopic)
      ? options.initialTopic
      : null,
  );
  const [note, setNote] = useState<string | null>(options.initialNote ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [visible, setVisible] = useState(15);
  const [noteFilter, setNoteFilter] = useState<"all" | "thesis" | "earnings" | "news">("all");
  const data = useQuery(queries.screen, { today: options.today, lang: lang() });
  const mark = useCommand(commands.markRead);
  const dismiss = useCommand(commands.dismissNote);
  const restore = useCommand(commands.restoreNote);
  const accept = useCommand(commands.acceptCandidate);
  const undo = useCommand(commands.undoAcceptCandidate);
  const rows = "notes" in data ? (data.notes ?? []) : [];
  const runs = "runs" in data ? (data.runs ?? []) : [];
  const candidates = rows.filter((row) => row.kind === "candidate");
  const filtered = rows.filter(
    (row) =>
      row.kind !== "candidate" &&
      !row.dismissed &&
      !row.expired &&
      (noteFilter === "all" ||
        (noteFilter === "thesis"
          ? ["supports", "weakens", "invalidates", "fulfills"].includes(row.thesis_relation)
          : row.kind === noteFilter)),
  );
  const opened = rows.find((row) => row.id === note);
  const topicRecord =
    data.status === "current"
      ? (data.topics.find((item) => item.key === topic)?.thesis ?? null)
      : null;
  const topicEditor = useResearchTopicForm(topic, topicRecord, privacy, setNotice);
  const display = {
    calendar: researchCalendarModel(data),
    scope: researchScopeModel(data),
    topics: researchTopicsModel(data),
    notes: rows,
    runs: runs.slice(0, 12).map((run) => ({
      run,
      day: researchDisplayDay(run.started_at),
      scope: researchRunScope(run),
    })),
    hasRun: runs.length > 0,
    candidates: researchNoteGroups(candidates),
    noteGroups: researchNoteGroups(filtered.slice(0, visible)),
    filteredCount: filtered.length,
    shownCount: Math.min(visible, filtered.length),
    held: researchHeldModel(data),
    opened: opened
      ? { note: opened, dates: researchNoteDates(opened), facts: researchNoteFacts(opened) }
      : null,
    topic: researchTopicModel(
      data,
      topic,
      rows,
      topicRecord?.view_updated_at,
      topicRecord?.view_sources ?? [],
    ),
  };
  const openTopic = (key: string) => {
    if (!research.isNoteSegment(key)) return;
    setTopic(key);
    void mark.run({ segment: key });
  };
  const openAsset = (instrument: string, gid?: string) => {
    void mark.run({ instrument });
    options.onOpenAsset(instrument, gid);
  };
  const openNote = (gid: string) => {
    const row = rows.find((item) => item.id === gid);
    if (!row) return;
    setNote(gid);
  };
  const finish = async (promise: Promise<{ ok: boolean; reason?: string }>, success = S.saved) => {
    try {
      const result = await promise;
      setNotice(result.ok ? success : `${S.refused}: ${result.reason ?? ""}`);
      return result.ok;
    } catch {
      setNotice(S.unknown);
      return false;
    }
  };
  const command =
    data.status === "current" && data.workspace.status === "current"
      ? data.workspace.value.command
      : null;
  const copyRun = async () => {
    if (!command || privacy) {
      setNotice(S.commandUnavailable);
      return;
    }
    try {
      await options.copyCommand(command);
      setNotice(S.copied);
    } catch {
      setNotice(S.copyFailed);
    }
  };
  return {
    data,
    display,
    privacy,
    tab,
    setTab,
    topic,
    setTopic,
    note,
    setNote,
    notice,
    visible,
    showMore: () => setVisible((n) => n + 15),
    noteFilter,
    setNoteFilter,
    topicForm: topicEditor.values,
    setTopicForm: topicEditor.setValues,
    topicRecord,
    saveTopic: topicEditor.submit,
    copyRun,
    onBack: options.onBack,
    onSettings: options.onSettings,
    openTopic,
    openAsset,
    openNote,
    dismiss: (gid: string) => finish(dismiss.run({ note: gid, lang: lang() })),
    restore: (gid: string) => finish(restore.run({ note: gid, lang: lang() })),
    accept: (gid: string, instrument: string | null) =>
      instrument
        ? finish(accept.run({ note: gid, lang: lang() }))
        : Promise.resolve(setNotice(S.resolutionUnavailable)),
    undoAccept: (gid: string) => finish(undo.run({ note: gid })),
    busy:
      mark.isPending ||
      dismiss.isPending ||
      restore.isPending ||
      accept.isPending ||
      undo.isPending ||
      topicEditor.busy,
  };
}

export type ResearchScreenState = ReturnType<typeof useResearchScreen>;
