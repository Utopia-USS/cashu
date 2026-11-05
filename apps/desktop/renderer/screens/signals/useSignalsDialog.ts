// The screen hook of the ported signals dialog (ab24ab6 v2/Signals.tsx SignalsDialog with useCursor /
// useFocusItem, SignalItem's and GroupActs' writes with their toasts and undo, useGroupWriter, and v2/Decide.tsx
// with useDecisionWriter): the dialog's UI state (filter, cursor, the open form and its values, the position
// decision dialog, the post-write locks), the j / k / Enter keys, the notification focus and the writes on the
// native commands (useLegacySignalsApi). The data is the Home's (old SignalsCtx, signalsCtxOf).
import { lang } from "@cashu/i18n";
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/Signals.strings";
import { signalsQueries } from "@cashu/store/investments/signals-screen";
import { useQuery } from "@cashu/store-react";
import { useToast, useUiEnv } from "@cashu/ui";
import { parseServerTime } from "@cashu/ui-logic/core/time";
import { dm } from "@cashu/ui-logic/investments/labels";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import type { Thesis } from "@cashu/ui-logic/investments/types";
import {
  cursorOrder,
  groupPlan,
  isDecided,
  type SignalFilter,
  type SignalGroup,
  signalScope,
  signalStateKey,
  splitByPolarity,
  splitByScope,
} from "@cashu/ui-logic/investments/v2/logic";
import { isResearchKind, signalNoteId } from "@cashu/ui-logic/investments/v2/research/logic";
import type { SignalV2 } from "@cashu/ui-logic/investments/v2/types";
import { useEffect, useState } from "react";
import { newestThesesOf } from "../investments/home/homeAdapters.js";
import { gidOf } from "../investments/home/legacyWire.js";
import type { InvestmentsHomeData } from "../investments/home/useInvestmentsHomeData.js";
import { stillLocked, useInFlight } from "./legacy/inflight.js";
import { errorText } from "./legacy/outcome.js";
import {
  canUndo,
  groupUndoRun,
  makeUndo,
  type Undo,
  undoMessage,
  undoSettled,
} from "./legacy/undo.js";
import { useShortcuts } from "./legacy/useShortcuts.js";
import type { SignalsDialogProps } from "./SignalsDialogView.js";
import { dayReadInstant } from "./signalModels.js";
import { signalsCtxOf } from "./signalsCtx.js";
import {
  type DecisionFormProps,
  decisionFormProps,
  type FormValues,
  formInput,
  type GroupProps,
  groupActions,
  groupHead,
  initialForm,
  itemProps,
  thesisProps,
  titleProps,
} from "./signalsDialogModel.js";
import { decidedThisWeek, instOf, type SignalsCtx, tagOf } from "./signalsModel.js";
import { useDisplayClock } from "./useDisplayClock.js";
import {
  type DecisionInput,
  type LegacySignalsApi,
  useLegacySignalsApi,
} from "./useLegacySignalsApi.js";
import type { PositionDecisionInput } from "./usePositionDecision.js";

const signalsQuery = signalsQueries().screen;
const ENTER = "Enter";

/** Scroll a dialog row into view (a cursor move: nearest; a focused signal: smooth, centred). */
const scrollTo = (id: number, smooth: boolean) =>
  document
    .querySelector<HTMLElement>(`[data-signal="${id}"]`)
    ?.scrollIntoView(smooth ? { behavior: "smooth", block: "center" } : { block: "nearest" });

/** One Undo per saved decision, shared by its toast and its row's `cofnij` (old Signals.tsx `undos`). */
const undos = new Map<number, Undo>();
function undoFor(decisionId: number, savedAt: number, run: () => Promise<unknown>): Undo {
  let u = undos.get(decisionId);
  if (!u) {
    u = makeUndo(savedAt, run);
    undos.set(decisionId, u);
  }
  return u;
}

export interface SignalsDialogInput {
  /** The Home's reads (useInvestmentsHomeData). */
  data: InvestmentsHomeData;
  /** Initial polarity filter. */
  filter?: SignalFilter;
  /** A signal to land on (a notification, a rail row): scroll, flash, cursor. Legacy number or gid. */
  focusId?: number | string | null;
  /** Review mode: the cursor on the first undecided signal, `bez decyzji: n` in the foot. */
  review?: boolean;
  /** Signals expired since the last review (digest), for the foot. */
  expired?: { title: string }[];
  /** The foot's `Dziennik decyzji`. */
  onHistory(): void;
  onClose(): void;
  onOpenAsset(gid: string): void;
  /** A research signal's `notatka`: the note (gid), its instrument (gid) and a segment key. */
  onOpenNote?(instrument: string | null, note: string | null, segment: string | null): void;
}

type Toast = ReturnType<typeof useToast>;

/** The writes of one signal row (old SignalItem), with the toast, the undo and the post-write lock. */
function rowWrites(o: {
  api: LegacySignalsApi;
  toast: Toast;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  lock(key: string, state: string): void;
  unlock(key: string): void;
  close(): void;
}) {
  const { api, toast } = o;
  const runUndo = async (u: Undo, what: string, retry: () => void, key: string) => {
    const res = await u.undo();
    if (undoSettled(res)) o.unlock(key);
    const msg = undoMessage(res, what);
    if (msg)
      toast(
        msg,
        res === "failed" ? 8000 : 3000,
        res === "failed" ? { label: C.undo, onClick: retry } : undefined,
      );
  };
  const offerUndo = (decisionId: number, text: string, what: string, key: string) => {
    const u = undoFor(decisionId, Date.now(), () => api.deleteDecision(decisionId));
    const retry = () => {
      void runUndo(u, what, retry, key);
    };
    toast(text, 10000, { label: C.undo, onClick: retry });
  };
  const keyOf = (s: SignalV2) => `s:${s.id}`;
  const ackNow = async (s: SignalV2, reason?: string) => {
    try {
      const r = await api.postAcknowledge(s.id, reason);
      o.lock(keyOf(s), signalStateKey(s));
      o.close();
      offerUndo(r.decision.id, S.ackDone, S.whatAck, keyOf(s));
    } catch (e) {
      toast(S.notSavedErr(errorText(e)), 5000);
    }
  };
  return {
    keyOf,
    decide: (s: SignalV2, input: DecisionInput, label: string) =>
      o.run(async () => {
        try {
          const r = await api.postDecision(s.id, input);
          o.lock(keyOf(s), signalStateKey(s));
          o.close();
          offerUndo(r.decision.id, S.decisionSaved(tagOf(label)), S.whatDecision, keyOf(s));
        } catch (e) {
          toast(S.decisionFailedErr(errorText(e)), 5000);
        }
      }),
    ack: (s: SignalV2, reason?: string) => {
      void o.run(() => ackNow(s, reason));
    },
    snooze: (s: SignalV2, until: string) =>
      o.run(async () => {
        try {
          await api.postSnooze(s.id, until);
          o.lock(keyOf(s), signalStateKey(s));
          const u = makeUndo(Date.now(), () => api.postSnooze(s.id, null));
          const retry = () => {
            void runUndo(u, S.whatSnooze, retry, keyOf(s));
          };
          toast(S.snoozedTo(dm(until)), 10000, { label: C.undo, onClick: retry });
        } catch (e) {
          toast(S.snoozeFailed(errorText(e)), 5000);
        }
      }),
    /** The row's `cofnij` of its latest decision (inside the 15 minutes). */
    undoRow: (s: SignalV2) => {
      const d = s.decisions[s.decisions.length - 1];
      if (!d || !canUndo(d)) return null;
      return () => {
        const u = undoFor(d.id, parseServerTime(d.created_at), () => api.deleteDecision(d.id));
        const retry = () => {
          void runUndo(u, S.whatDecision, retry, keyOf(s));
        };
        retry();
      };
    },
    /** Old useGroupWriter `offer`: one toast with one undo for several saved decisions. */
    offerGroup: (ids: number[], text: string, what: string, key: string) => {
      if (!ids.length) return;
      const u = makeUndo(
        Date.now(),
        groupUndoRun(ids, (id) => api.deleteDecision(id)),
      );
      const retry = () => {
        void runUndo(u, what, retry, key);
      };
      toast(text, 10000, { label: C.undo, onClick: retry });
    },
  };
}

export function useSignalsDialog(
  o: SignalsDialogInput,
): SignalsDialogProps & { position: PositionDecisionInput | null } {
  const toast = useToast();
  const api = useLegacySignalsApi();
  const flight = useInFlight();
  const { privacy } = useUiEnv();
  const displayNow = useDisplayClock(o.data.today);
  const ctx: SignalsCtx = signalsCtxOf(o.data);
  const snapshot = useQuery(signalsQuery, {
    now: dayReadInstant(o.data.today),
    today: o.data.today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: lang(),
    privacy,
  });
  const list = o.data.signals;
  const held = ctx.held;
  const [filter, setFilter] = useState<SignalFilter>(o.filter ?? "all");
  // Review step 2 puts the cursor on the first undecided signal; a focused signal (a notification, a rail row)
  // takes it, scrolls into view and flashes once (old useFocusItem).
  const [landing] = useState(() => {
    const id =
      typeof o.focusId === "string" ? list.find((s) => gidOf(s.id) === o.focusId)?.id : o.focusId;
    if (id != null && list.some((s) => s.id === id)) return { id, flash: true };
    const firstOpen = o.review
      ? cursorOrder(list, signalsCtxOf(o.data).held, o.filter ?? "all")[0]
      : null;
    return firstOpen ? { id: firstOpen.id, flash: false } : null;
  });
  const [cursor, setCursor] = useState<number | null>(landing?.id ?? null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [locks, setLocks] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<number | null>(null);
  const { positive, negative } = splitByPolarity(list);
  const cols = splitByScope(list, held, filter);
  const twoCols = ctx.watch.length > 0 || list.some((s) => signalScope(s, held) === "watched");
  const order = cursorOrder(list, held, filter);
  const first = order[0]?.id ?? -1;

  // Theses of the instruments with an open signal (one per instrument, held positions with a thesis).
  const ids = [
    ...new Set(
      list
        .filter(
          (s) =>
            s.instrument_id != null &&
            ctx.positions.some(
              (p) => String(p.instrument.id) === String(s.instrument_id) && p.has_thesis,
            ),
        )
        .map((s) => Number(s.instrument_id)),
    ),
  ];
  const theses: Map<number, Thesis> = newestThesesOf(snapshot, ids);

  // A group's position decision dialog on top: the cursor keys stay with it.
  const groupOf = (id: number | null) =>
    id == null
      ? null
      : ([...cols.portfolio, ...cols.watched].find(
          (g) => g.signals.length > 1 && g.live.some((x) => x.id === id),
        ) ?? null);
  const openGroup = groupOf(openId);
  const dialogGroup =
    openGroup && openGroup.instrumentId != null && instOf(ctx, openGroup.instrumentId)
      ? openGroup
      : null;

  const move = (d: number) => {
    if (!order.length) return;
    const i = order.findIndex((s) => s.id === cursor);
    const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + d))];
    if (!next) return;
    setCursor(next.id);
    scrollTo(next.id, false);
  };
  const toggle = (id: number | null, s: SignalV2 | null, instrumentId: number | null) => {
    setOpenId(id);
    setForm(id == null ? null : initialForm(`s:${id}`, s, instrumentId, ctx));
    if (id != null) setCursor(id);
  };
  const openFor = (id: number) => {
    const s = list.find((x) => x.id === id) ?? null;
    const g = groupOf(id);
    toggle(id, g?.primary ?? s, g?.instrumentId ?? null);
  };
  useShortcuts(
    {
      j: () => move(1),
      k: () => move(-1),
      [ENTER]: () => {
        if (cursor == null) return;
        if (openId === cursor) toggle(null, null, null);
        else openFor(cursor);
      },
    },
    dialogGroup === null,
  );
  useEffect(() => {
    if (!landing?.flash) return;
    const t = setTimeout(() => {
      scrollTo(landing.id, true);
      setFlash(landing.id);
    }, 60);
    const done = setTimeout(() => setFlash(null), 2660);
    return () => {
      clearTimeout(t);
      clearTimeout(done);
    };
  }, [landing]);

  const lock = (key: string, state: string) => setLocks((l) => ({ ...l, [key]: state }));
  const unlock = (key: string) =>
    setLocks((l) => {
      const { [key]: _, ...rest } = l;
      return rest;
    });
  const close = () => toggle(null, null, null);
  const leave =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      o.onClose();
      fn(...a);
    };
  const openAsset = leave((id: number) => {
    const gid = gidOf(id);
    if (gid !== null) o.onOpenAsset(gid);
  });
  const w = rowWrites({ api, toast, run: flight.run, lock, unlock, close });
  const later = nextDeposit(ctx.today, ctx.contributionDay);

  const formOf = (
    s: SignalV2 | null,
    instrumentId: number | null,
    extra: {
      pending: boolean;
      hideAck?: boolean;
      onDecide(input: DecisionInput, label: string): Promise<unknown> | undefined;
      onAck?: (reason?: string) => void;
      onCollapse(): void;
    },
  ): DecisionFormProps | null => {
    if (!form) return null;
    return decisionFormProps({
      f: form,
      s,
      instrumentId,
      ctx,
      pending: extra.pending,
      hideAck: extra.hideAck,
      onChange: (patch) => setForm((f) => (f ? { ...f, ...patch } : f)),
      onSave: () => {
        const { input, label } = formInput(form, s, instrumentId, ctx);
        setForm((f) => (f ? { ...f, busy: true } : f));
        void Promise.resolve(extra.onDecide(input, label)).finally(() =>
          setForm((f) => (f ? { ...f, busy: false } : f)),
        );
      },
      onAck: extra.onAck,
      onCollapse: extra.onCollapse,
      onOpenNotes: openAsset,
    });
  };
  const collapse = (id: number) => {
    close();
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-signal="${id}"] [data-act] button:not([disabled])`)
        ?.focus(),
    );
  };

  const item = (s: SignalV2, sub: boolean, thesis: Thesis | null) => {
    const key = w.keyOf(s);
    const busy = flight.busy || stillLocked(locks[key], signalStateKey(s));
    const open = !sub && openId === s.id;
    const research = isResearchKind(s.kind) || s.source === "research";
    const segment = typeof s.payload.segment === "string" ? s.payload.segment : null;
    return itemProps({
      s,
      ctx,
      thesis,
      sub,
      open,
      cursor: cursor === s.id,
      primary: s.id === first,
      flash: flash === s.id,
      busy,
      later,
      form: open
        ? formOf(s, null, {
            pending: busy,
            onDecide: (input, label) => (busy ? undefined : w.decide(s, input, label)),
            onAck: (reason) => {
              if (!busy) w.ack(s, reason);
            },
            onCollapse: () => collapse(s.id),
          })
        : null,
      cb: {
        onDecide: () => toggle(s.id, s, null),
        onAck: () => {
          if (!busy) w.ack(s);
        },
        onSnooze: () => {
          if (!busy) void w.snooze(s, later);
        },
        onNote:
          research && o.onOpenNote
            ? leave(() => {
                const noteId = signalNoteId(s);
                o.onOpenNote?.(
                  gidOf(s.instrument_id),
                  noteId == null ? null : gidOf(noteId),
                  segment,
                );
              })
            : null,
        onUndo: w.undoRow(s),
        onOpenAsset: openAsset,
      },
    });
  };

  const groupKey = (g: SignalGroup<SignalV2>) => `g:${g.key}`;
  const groupState = (g: SignalGroup<SignalV2>) => g.live.map(signalStateKey).join(";");
  /** Old useGroupWriter `writeAll`: in order; a failure keeps what was saved (with its undo) and says so. */
  const writeAll = (
    g: SignalGroup<SignalV2>,
    steps: (() => Promise<{ decision: { id: number } }>)[],
    text: string,
    what: string,
    failText: string,
  ) =>
    flight.run(async () => {
      const saved: number[] = [];
      try {
        for (const step of steps) saved.push((await step()).decision.id);
        lock(groupKey(g), groupState(g));
        close();
        w.offerGroup(saved, text, what, groupKey(g));
      } catch (e) {
        if (saved.length) w.offerGroup(saved, `${failText}: ${errorText(e)}`, what, groupKey(g));
        else toast(`${failText}: ${errorText(e)}`, 5000);
      }
    });

  const group = (g: SignalGroup<SignalV2>): GroupProps | null => {
    const head = g.primary ?? g.signals[0];
    const only = g.signals[0];
    if (!head || !only) return null;
    if (g.signals.length === 1)
      return {
        kind: "single",
        key: g.key,
        item: item(
          only,
          false,
          only.instrument_id != null ? (theses.get(only.instrument_id) ?? null) : null,
        ),
      };
    const t = theses.get(g.instrumentId ?? -1) ?? null;
    const busy = flight.busy || stillLocked(locks[groupKey(g)], groupState(g));
    const open = g.live.some((x) => x.id === openId);
    const inDialog = open && g.instrumentId != null && instOf(ctx, g.instrumentId) != null;
    const plan = groupPlan(g);
    const decide = (input: DecisionInput, label: string) => {
      if (!plan || busy) return undefined;
      const tag = tagOf(label);
      return writeAll(
        g,
        [
          () => api.postDecision(plan.primary.id, input),
          // `decyzja: ` is a stored marker (v2/logic.ts folds these acknowledgements into the decision): never localized.
          ...plan.rest.map((x) => () => api.postAcknowledge(x.id, `decyzja: ${tag}`)),
        ],
        S.decisionSaved(tag),
        S.whatDecision,
        S.decisionFailed,
      );
    };
    const ack = (reason?: string) => {
      if (busy) return;
      void writeAll(
        g,
        g.live.map((x) => () => api.postAcknowledge(x.id, reason)),
        S.ackDone,
        S.whatAck,
        S.notSaved,
      );
    };
    const live = g.live[0];
    return {
      kind: "group",
      key: g.key,
      quiet: g.settled,
      ...groupHead(g),
      title: titleProps(head, ctx, groupHead(g).count, openAsset),
      thesis: !g.settled ? thesisProps(t) : null,
      items: [...g.live, ...g.signals.filter((x) => !g.live.includes(x))].map((x) =>
        item(x, true, null),
      ),
      acts:
        !g.live.length || !g.primary
          ? null
          : open && !inDialog
            ? {
                actions: null,
                form: formOf(g.primary, null, {
                  pending: busy,
                  onDecide: decide,
                  onAck: ack,
                  onCollapse: close,
                }),
              }
            : {
                actions: groupActions(
                  g,
                  g.live.some((x) => x.id === first),
                  busy,
                  () => live && toggle(live.id, g.primary, g.instrumentId),
                  () => ack(),
                ),
                form: null,
              },
    };
  };

  // ---- the position decision dialog (Decide.tsx) over the dialog: its input (PositionDecisionScreen) ----
  const position: Omit<PositionDecisionInput, "ctx"> | null =
    dialogGroup && dialogGroup.instrumentId != null
      ? {
          instrumentId: dialogGroup.instrumentId,
          signals: dialogGroup.live,
          thesis: theses.get(dialogGroup.instrumentId) ?? null,
          onClose: close,
          onOpenNotes: openAsset,
        }
      : null;

  const col = (label: string, groups: SignalGroup<SignalV2>[]) => ({
    label,
    count: groups.reduce((a, g) => a + g.signals.length, 0),
    groups: groups.map(group).filter((g): g is GroupProps => g !== null),
    none: S.none,
  });
  const decided = list.filter(isDecided).length;
  const expired = o.expired ?? [];
  return {
    label: S.signals,
    title: S.signals,
    count: list.length > 0 ? list.length : null,
    decided: o.review && decided > 0 ? S.decided(decided) : null,
    filter: {
      label: S.filter,
      items: [
        [S.all, "all"],
        [S.chancesN(positive.length), "positive"],
        [S.risksN(negative.length), "negative"],
      ],
      value: filter,
      onChange: setFilter,
    },
    hint: S.keysHint,
    empty: list.length ? null : S.noOpen,
    columns: twoCols
      ? [col(S.portfolio, cols.portfolio), col(S.watched, cols.watched)]
      : [col(S.portfolio, cols.portfolio)],
    foot: o.review
      ? [{ text: S.undecided, bold: String(list.length - decided), tail: "" }]
      : [
          {
            text: S.decisionsLabel,
            bold: S.xOfY(decidedThisWeek(list, Date.parse(displayNow)), list.length),
            tail: ` ${S.thisWeek}`,
          },
          ...(expired.length
            ? [
                {
                  text: `${S.expired(expired.length)} (${expired
                    .slice(0, 2)
                    .map((e) => e.title)
                    .join(", ")})`,
                  bold: null,
                  tail: "",
                },
              ]
            : []),
        ],
    journal: { label: S.journal, onPress: leave(o.onHistory) },
    onClose: o.onClose,
    /** The open position decision dialog (render PositionDecisionScreen with `ctx`). */
    position: position && { ...position, ctx },
  };
}
