// The topic drawer's screen hook (ab24ab6 v2/research/TopicDrawer.tsx TopicDetail + TopicThesisWidget +
// useTopicNotes): the Home's reads in the old shapes, the in-place thesis edit (native owner commands, in order,
// through topic-save.ts), the note actions with their toasts and marking the key's unread notes read on open.
import { S } from "@cashu/i18n/investments/v2/research/TopicDrawer.strings";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import { useCommand } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import { type InstLike, instName } from "@cashu/ui-logic/investments/v2/logic";
import { canonKey, topicSavePlan } from "@cashu/ui-logic/investments/v2/research/segments";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { InvestmentsHomeData } from "../investments/home/useInvestmentsHomeData.js";
import { instStateOf, tileOf } from "../investments/home/widgets/instState.js";
import { useDisplayClock } from "../signals/useDisplayClock.js";
import { useDurableCommands } from "../useDurableCommand.js";
import { S as R } from "./Research.strings.js";
import type { TopicDrawerActions } from "./TopicDrawerView.js";
import { saveTopicSequence } from "./topic-save.js";
import { type TopicEdit, topicDrawerModel, topicKeyOf } from "./topicDrawerModel.js";
import { useResearchActions } from "./useResearchActions.js";

const commands = researchScreenCommands();

export interface TopicDrawerOptions {
  data: InvestmentsHomeData;
  /** The route's key: a segment key (legacy ones canonical) or a macro regime's `macro_<key>`. */
  topic: string;
  onClose(): void;
  onCrumb(where: "home" | "section"): void;
  /** A member opens its asset (legacy instrument number). */
  onOpenAsset(instrumentId: number): void;
}

export function useTopicDrawer(o: TopicDrawerOptions) {
  const { data } = o;
  const key = topicKeyOf(o.topic);
  const toast = useToast();
  const actions = useResearchActions();
  const durable = useDurableCommands();
  const markRead = useCommand(commands.markRead);
  const saveThesis = useCommand(commands.saveTopicThesis);
  const deleteThesis = useCommand(commands.deleteTopicThesis);
  const setView = useCommand(commands.setTopicMarketView);
  const now = Date.parse(useDisplayClock(data.today));
  const r = data.research;
  const t = r.topics.get(key) ?? null;
  const [edit, setEdit] = useState<TopicEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<number | null>(null);
  // Privacy mode hides the topic and refuses its writes (native rule, data safety over parity); the ref lets a
  // save in flight stop before its second write once privacy turns on.
  const privacy = data.privacy;
  const hidden = useRef(privacy);
  useLayoutEffect(() => {
    hidden.current = privacy;
  });

  // Opening marks the key's unread agent notes read, once (old useTopicNotes).
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || privacy || !r.notes.some((n) => n.segment === key && n.unread === true))
      return;
    marked.current = true;
    void durable.run(`mark-segment:${key}`, markRead, { segment: key });
  }, [r.notes, key, durable, markRead, privacy]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** One save: the native sequence (thesis, then the market view); `done` = the old toast. */
  const run = async (e: TopicEdit, confirm: boolean, done: string) => {
    if (hidden.current) return;
    setBusy(true);
    setErr(null);
    let ok = false;
    await saveTopicSequence({
      topic: key,
      record: t,
      value: { ...e, clearSources: false, confirmDraft: confirm },
      current: () => alive.current && !hidden.current,
      saveThesis: (input) => durable.run(`topic-thesis:${key}`, saveThesis, input),
      deleteThesis: (input) => durable.run(`topic-thesis:${key}`, deleteThesis, input),
      setView: (input) => durable.run(`topic-view:${key}`, setView, input),
      saved: () => {
        ok = true;
      },
      notice: (message) => {
        if (ok) return;
        if (message === R.noChanges) {
          ok = true;
          done = S.noChanges;
        } else setErr(S.saveFailed(message));
      },
    });
    if (!alive.current) return;
    setBusy(false);
    if (hidden.current) return;
    if (!ok) return;
    setEdit(null);
    toast(done, 2000);
  };

  const held = new Map<number, { name: string; symbol: string | null; inst: InstLike }>();
  for (const p of data.pos.data?.positions ?? [])
    held.set(Number(p.instrument.id), {
      name: instName(p.instrument),
      symbol: p.instrument.symbol ?? null,
      inst: p.instrument,
    });
  const watched = new Map<number, { name: string; symbol: string | null; inst: InstLike }>();
  const watchedTopics = new Map<string, string[]>();
  for (const w of data.watchQ.data ?? []) {
    if (!w.instrument) continue;
    watched.set(w.instrument_id, {
      name: instName(w.instrument),
      symbol: w.instrument.symbol ?? null,
      inst: w.instrument,
    });
    const k = canonKey(w.instrument.segment);
    const s = w.instrument.symbol;
    if (k && s && !w.held) watchedTopics.set(k, [...(watchedTopics.get(k) ?? []), s]);
  }
  const st = instStateOf(data);
  const model = topicDrawerModel(
    {
      key,
      today: data.today,
      now,
      notes: r.notes,
      segments: r.segments,
      macro: r.macro,
      thesis: t,
      symOf: (id) =>
        held.get(id)?.symbol ??
        watched.get(id)?.symbol ??
        r.summary?.instruments.find((s) => s.instrument_id === id)?.instrument?.symbol ??
        null,
      instOf: (id) => held.get(id) ?? watched.get(id) ?? null,
      tileOf: (inst) => tileOf(inst, st),
      watchedTopics,
    },
    {
      edit,
      busy,
      err,
      openNote,
      onToggleNote: (id) => setOpenNote((x) => (x === id ? null : id)),
      onDismiss: (n) => actions.dismiss(n),
      onRestore: (n) => actions.restore(n),
      onOpenAsset: o.onOpenAsset,
    },
  );
  const a: TopicDrawerActions = {
    onClose: o.onClose,
    onCrumb: o.onCrumb,
    onEdit: () => {
      if (hidden.current) return;
      setErr(null);
      setEdit({
        thesis: t?.thesis ?? "",
        invalidation: t?.invalidation ?? "",
        assessment: t?.assessment ?? "",
        outlook: t?.outlook ?? "",
      });
    },
    onCancel: () => setEdit(null),
    onField: (k, v) => setEdit((e) => (e ? { ...e, [k]: v } : e)),
    onSave: () => {
      if (!edit) return;
      const plan = topicSavePlan(t, edit);
      return run(
        edit,
        true,
        !edit.thesis.trim()
          ? S.removed
          : plan.thesis
            ? S.thesisSaved
            : plan.view
              ? S.viewSaved
              : S.noChanges,
      );
    },
    onConfirm: () => {
      if (!t) return;
      return run(
        {
          thesis: t.thesis,
          invalidation: t.invalidation ?? "",
          assessment: t.assessment ?? "",
          outlook: t.outlook ?? "",
        },
        true,
        S.confirmed,
      );
    },
  };
  return { model: { ...model, hidden: privacy ? R.hidden : null }, a };
}
