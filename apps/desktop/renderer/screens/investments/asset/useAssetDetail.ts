// Screen hook of the asset detail (ab24ab6 v2/AssetPage.tsx AssetDetail + AssetResearch): the Home's data (the
// old detail rendered inside the Home and read its positions, alerts, watchlist and research), the instrument's
// detail and price chart (the native asset query in the old shapes), every signal of the profile, and the old
// writes (watch toggle, watch note, topic, acknowledge, research notes, mark read) with their toasts.

import { lang } from "@cashu/i18n";
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/AssetPage.strings";
import { S as SG } from "@cashu/i18n/investments/v2/SegmentSelect.strings";
import { S as G } from "@cashu/i18n/investments/v2/Signals.strings";
import { S as W } from "@cashu/i18n/investments/v2/Watchlist.strings";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import {
  classifyUiInstrument,
  investmentDesktopQueries,
  updateUiWatchNote,
} from "@cashu/store/investments/screen";
import { signalsQueries } from "@cashu/store/investments/signals-screen";
import { useCommand, useQuery } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import { label } from "@cashu/ui-logic/core/messages";
import { instName } from "@cashu/ui-logic/investments/v2/logic";
import { addedToast } from "@cashu/ui-logic/investments/v2/searchLogic";
import type { PositionChart, PositionDetail } from "@cashu/ui-logic/investments/v2/types";
import { useEffect, useRef, useState, useTransition } from "react";
import { errorText } from "../../signals/legacy/outcome.js";
import { makeUndo } from "../../signals/legacy/undo.js";
import { offerRecreate, offerUndo } from "../../signals/legacy/undoFlow.js";
import { dayReadInstant } from "../../signals/signalModels.js";
import { signalsCtxOf } from "../../signals/signalsCtx.js";
import { useDisplayClock } from "../../signals/useDisplayClock.js";
import { useLegacySignalsApi } from "../../signals/useLegacySignalsApi.js";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import { openSignalsOf } from "../home/homeAdapters.js";
import { gidOf, legacyId, wire } from "../home/legacyWire.js";
import { useInvestmentsHomeData, useResearchNoteActions } from "../home/useInvestmentsHomeData.js";
import { instStateOf, isHeld, tileOf } from "../home/widgets/instState.js";
import { type AssetMode, assetModel, segmentModel, segmentTitle } from "./assetModel.js";
import { assetResearchModel, researchShown, thesisHealthPill } from "./assetResearchModel.js";

const portfolio = investmentDesktopQueries();
const signalsQuery = signalsQueries().screen;
const research = researchScreenCommands();

/** Names seen this session (old NAMES, per window: legacy ids are per window too). */
const NAMES = new Map<number, string>();

export interface AssetDetailInput {
  /** The instrument gid of the route. */
  readonly instrument: string;
  /** The Home's account filter (a legacy account id); null = all. */
  readonly filter: number | null;
  readonly mode: AssetMode;
  /** `?note=` of the deep link: open and highlight that research note. */
  readonly noteGid?: string | null;
}

export function useAssetDetail(input: AssetDetailInput) {
  const toast = useToast();
  const data = useInvestmentsHomeData({ filter: input.filter });
  const { today, privacy } = data;
  const language = lang();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [months, setMonthsNow] = useState(24);
  const [, startTransition] = useTransition();
  // A new range keeps the current chart until the new one is read (the old chart kept its data while loading).
  const setMonths = (m: number) => startTransition(() => setMonthsNow(m));
  const [lotsOpen, setLotsOpen] = useState(false);
  const [decideOpen, setDecideOpen] = useState(false);
  const signalsRead = useQuery(signalsQuery, {
    now: dayReadInstant(today),
    today,
    timeZone,
    lang: language,
    privacy,
  });
  const asset = useQuery(portfolio.asset, {
    today,
    timeZone,
    lang: language,
    account: null,
    range: "1y",
    instrument: input.instrument,
    months,
  });
  const id = legacyId(input.instrument);
  // Every signal of the profile (old getSignalsV2("all")): the open list's adapter over the whole list.
  const allSignals =
    signalsRead.status === "ready"
      ? (openSignalsOf({ ...signalsRead, open: signalsRead.signals }).data ?? [])
      : [];
  const detail = asset.status === "ready" ? wire<PositionDetail>(asset.detail) : null;
  const chart = asset.status === "ready" ? wire<PositionChart>(asset.chart) : null;
  const positions = data.pos.data?.positions ?? [];
  const watch = data.watchQ.data ?? [];
  const st = instStateOf(data);
  const pos = positions.find((p) => String(p.instrument.id) === String(id));
  const w = watch.find((x) => x.instrument_id === id);
  const inst = pos?.instrument ?? detail?.instrument ?? w?.instrument ?? null;
  if (inst) NAMES.set(id, instName(inst));
  const small =
    typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 640px)").matches;
  const model = assetModel({
    id,
    mode: input.mode,
    today,
    positions,
    alerts: data.alertsQ.data ?? [],
    watch,
    ctx: signalsCtxOf(data),
    detail,
    chart,
    signals: allSignals,
    heldAnywhere: isHeld(st, id),
    tile: inst ? tileOf(inst, st) : { monogram: "" },
    knownName: NAMES.get(id) ?? null,
    small,
    lotsOpen,
    months,
  });
  const api = useLegacySignalsApi();
  const durable = useDurableCommands();
  const changed = () => undefined; // the live queries re-read on their own

  // ---- header: watch toggle (F12 F2) ----
  const [watchBusy, setWatchBusy] = useState(false);
  const toggleWatch = async () => {
    if (watchBusy) return;
    setWatchBusy(true);
    try {
      if (w) {
        try {
          await api.deleteWatch(w.id);
          offerRecreate(
            toast,
            W.removed(model.name),
            () =>
              api.postWatch({
                instrument_id: w.instrument_id,
                note: w.note,
                tags: w.tags?.length ? w.tags : null,
              }),
            W.removeWhat,
            changed,
            errorText,
            10000,
            () => (w.source === "agent" ? W.backAsYours : null),
          );
        } catch (e) {
          toast(W.removeFailed(errorText(e)), 4000);
        }
        return;
      }
      const r = await api.postWatch({ instrument_id: id });
      toast(
        addedToast(r, model.name, (x) => label(`error.${x.code}`) ?? x.message),
        6000,
      );
    } catch (e) {
      toast(S.addFailed(errorText(e)), 4000);
    } finally {
      setWatchBusy(false);
    }
  };

  // ---- meta line: topic select (SegmentSelect.tsx) ----
  const classify = useCommand(classifyUiInstrument);
  const seg = inst ? segmentModel(inst) : null;
  // The chosen value until a re-read brings the stored one (a pick made over another stored value is dropped).
  const [segPick, setSegPick] = useState<{ base: string; value: string } | null>(null);
  const [segBusy, setSegBusy] = useState(false);
  const segStored = seg?.value ?? "";
  const segShown = segPick && segPick.base === segStored ? segPick.value : segStored;
  const saveSegment = async (next: string) => {
    const gid = inst ? gidOf(inst.id) : null;
    if (!gid) return;
    setSegPick({ base: segStored, value: next });
    setSegBusy(true);
    try {
      const r = await durable.run(`segment:${gid}`, classify, {
        instrument: gid,
        patch: { segment: next || null },
      });
      if (r.kind !== "completed") {
        setSegPick(null);
        toast(SG.saveFailed(commandFailure(r)), 4000);
      }
    } finally {
      setSegBusy(false);
    }
  };

  // ---- open signals: acknowledge one (useSignalAck) or all (GroupAck), toast + Cofnij ----
  const [ackBusy, setAckBusy] = useState<Set<number>>(new Set());
  const ackRun = async (ids: number[]) => {
    setAckBusy(new Set(ids));
    const saved: number[] = [];
    try {
      for (const s of ids) saved.push((await api.postAcknowledge(s)).decision.id);
      offerUndo(
        toast,
        G.ackDone,
        makeUndo(Date.now(), async () => {
          for (const d of saved) await api.deleteDecision(d);
        }),
        G.whatAck,
        changed,
      );
    } catch (e) {
      toast(G.notSavedErr(errorText(e)), 5000);
    } finally {
      setAckBusy(new Set());
    }
  };

  // ---- Dlaczego obserwuję (WatchNote, PATCH /watchlist) ----
  const watchNote = useCommand(updateUiWatchNote);
  const [draft, setDraft] = useState<string | null>(null);
  // The saved text until the re-read watchlist carries it (old WatchNote `saved`).
  const [savedNote, setSavedNote] = useState<{ base: string | null; value: string | null } | null>(
    null,
  );
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const storedNote = w?.note ?? null;
  const note = savedNote && savedNote.base === storedNote ? savedNote.value : storedNote;
  const saveNote = async () => {
    const item = w ? gidOf(w.id) : null;
    if (draft == null || !item || !w) return;
    setNoteBusy(true);
    setNoteErr(null);
    try {
      const text = draft.trim();
      const r = await durable.run(`note:${item}`, watchNote, {
        item,
        note: text,
        tags: [...(w.tags ?? [])],
      });
      if (r.kind !== "completed") {
        setNoteErr(S.saveFailed(commandFailure(r)));
        return;
      }
      setSavedNote({ base: storedNote, value: text || null });
      setDraft(null);
      toast(C.saved, 2000);
    } finally {
      setNoteBusy(false);
    }
  };

  // ---- research (AssetResearch / ThesisHealth / useResearchShown) ----
  const notes = data.research.notes.filter((n) => n.instrument_id === id);
  const rInputs = {
    instrumentId: id,
    held: !!pos,
    thesis: model.thesis,
    notes,
    summary: data.research.summary,
    runs: data.research.runs,
    today,
  };
  const hlId = input.noteGid ? legacyId(input.noteGid) : null;
  const now = Date.parse(useDisplayClock(today));
  // Deep link: older notes open when the target is among them (the detail mounts with its data read).
  const [older, setOlder] = useState(() => {
    const first = assetResearchModel(rInputs, {
      older: false,
      openId: hlId,
      highlightId: hlId,
      now,
    });
    return first.ran && hlId != null && first.olderIds.includes(hlId);
  });
  const [openId, setOpenId] = useState<number | null>(hlId);
  const notesActions = useResearchNoteActions();
  const markRead = useCommand(research.markRead);
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || privacy || !notes.some((n) => n.unread === true)) return;
    marked.current = true;
    void durable.run(`mark:${input.instrument}`, markRead, { instrument: input.instrument });
  }, [notes, privacy, durable, markRead, input.instrument]);
  const researchModel = assetResearchModel(rInputs, { older, openId, highlightId: hlId, now });
  // Deep link: scroll the target row into view.
  useEffect(() => {
    if (hlId == null) return;
    const t = setTimeout(
      () =>
        document
          .getElementById(`note-${hlId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      120,
    );
    return () => clearTimeout(t);
  }, [hlId]);
  const noteById = (nid: number) => notes.find((n) => n.id === nid) ?? null;
  const noteAction = async (nid: number, run: typeof notesActions.dismiss) => {
    const n = noteById(nid);
    if (!n) return;
    const err = await run(n);
    if (err) toast(err, 5000);
  };

  return {
    model,
    /** The Home's reads (the position decision dialog's context). */
    data,
    privacy,
    mode: input.mode,
    decideOpen,
    closeDecide: () => setDecideOpen(false),
    researchShown: researchShown(rInputs),
    researchModel,
    thesisPill: thesisHealthPill(rInputs),
    research: {
      onToggleOlder: () => setOlder((v) => !v),
      onToggleNote: (nid: number) => setOpenId((v) => (v === nid ? null : nid)),
      onDismiss: (nid: number) => void noteAction(nid, notesActions.dismiss),
      onRestore: (nid: number) => void noteAction(nid, notesActions.restore),
    },
    ui: {
      setMonths,
      lotsOpen,
      toggleLots: () => setLotsOpen((v) => !v),
      onToggleWatch: () => void toggleWatch(),
      watchBusy,
      onDecide: () => setDecideOpen(true),
      segment: seg
        ? {
            value: segShown,
            busy: segBusy,
            title: segmentTitle(seg, segShown),
            onChange: (v: string) => void saveSegment(v),
          }
        : null,
      onAck: (sid: number) => void ackRun([sid]),
      ackBusy: (sid: number) => ackBusy.has(sid),
      onAckAll: () => void ackRun(model.open.map((s) => s.id)),
      ackAllBusy: ackBusy.size > 0,
      note: {
        draft,
        saved: note,
        busy: noteBusy,
        error: noteErr,
        onEdit: () => {
          setNoteErr(null);
          setDraft(note ?? "");
        },
        onDraft: setDraft,
        onCancel: () => setDraft(null),
        onSave: () => void saveNote(),
      },
    },
  };
}

/** The instrument's name for the drawer label and crumb before the detail loads (old `assetName`: positions,
 * then the watchlist, then a name seen this session). */
export function useAssetName(instrument: string, filter: number | null): string {
  const data = useInvestmentsHomeData({ filter });
  const id = legacyId(instrument);
  const p = (data.pos.data?.positions ?? []).find((x) => String(x.instrument.id) === String(id));
  const w = p ? null : (data.watchQ.data ?? []).find((x) => x.instrument_id === id);
  const name = p ? instName(p.instrument) : w?.instrument ? instName(w.instrument) : null;
  if (name) NAMES.set(id, name);
  return name ?? NAMES.get(id) ?? S.instrument(id);
}
