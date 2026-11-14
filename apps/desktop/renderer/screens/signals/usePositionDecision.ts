// The one decision per position (ab24ab6 v2/Decide.tsx PositionDecisionDialog + Signals.tsx useDecisionWriter): the
// open signals as context, the thesis line and the decision form; one save writes one decision linked to every
// listed signal (`positions/{id}/decision`), one toast with one `Cofnij`. A refusal because the signals changed
// meanwhile says so; the dialog stays for a retry on a failure.
import { C } from "@cashu/i18n/core/common.strings";
import { S as DF } from "@cashu/i18n/investments/v2/decisionFlow.strings";
import { S } from "@cashu/i18n/investments/v2/Signals.strings";
import { useToast } from "@cashu/ui";
import type { Thesis } from "@cashu/ui-logic/investments/types";
import { instName } from "@cashu/ui-logic/investments/v2/logic";
import type { SignalV2 } from "@cashu/ui-logic/investments/v2/types";
import { useState } from "react";
import { useInFlight } from "./legacy/inflight.js";
import { errorText } from "./legacy/outcome.js";
import { groupUndoRun, makeUndo, undoMessage } from "./legacy/undo.js";
import {
  decisionFormProps,
  type FormValues,
  formInput,
  initialForm,
  type PositionDialogProps,
  positionDialogProps,
} from "./signalsDialogModel.js";
import { instOf, type SignalsCtx, tagOf } from "./signalsModel.js";
import { useLegacySignalsApi } from "./useLegacySignalsApi.js";

export interface PositionDecisionInput {
  ctx: SignalsCtx;
  /** The instrument (legacy number). */
  instrumentId: number;
  /** The undecided open signals of the instrument (byTime order): all of them are covered by the decision. */
  signals: SignalV2[];
  thesis: Thesis | null;
  onClose(): void;
  /** After a save went through. */
  onSaved?(): void;
  /** The research line's `otwórz notatki` (the asset). */
  onOpenNotes?(instrumentId: number): void;
}

/** The undo window starts when the save answered (module scope: not a render-time read). */
const nowMs = () => Date.now();

/** A refused position decision whose signals changed meanwhile (decisionFlow.ts staleSignalText). */
function staleSignalText(e: unknown): string | null {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : null;
  if (code === "signal_closed") return DF.signalClosed;
  if (code === "other_instrument") return DF.otherInstrument;
  return null;
}

export function usePositionDecision(o: PositionDecisionInput): PositionDialogProps | null {
  const toast = useToast();
  const api = useLegacySignalsApi();
  const flight = useInFlight();
  const { ctx, instrumentId, signals } = o;
  const [form, setForm] = useState<FormValues>(() =>
    initialForm(`p${instrumentId}`, signals[0] ?? null, instrumentId, ctx),
  );
  const io = instOf(ctx, instrumentId);
  if (!io) return null;
  const offer = (ids: number[], text: string) => {
    const u = makeUndo(
      nowMs(),
      groupUndoRun(ids, (id) => api.deleteDecision(id)),
    );
    const retry = () => {
      void u.undo().then((res) => {
        const msg = undoMessage(res, S.whatDecision);
        if (msg)
          toast(
            msg,
            res === "failed" ? 8000 : 3000,
            res === "failed" ? { label: C.undo, onClick: retry } : undefined,
          );
      });
    };
    toast(text, 10000, { label: C.undo, onClick: retry });
  };
  const s0 = signals[0] ?? null;
  const save = () => {
    const { input, label } = formInput(form, s0, instrumentId, ctx);
    setForm((f) => ({ ...f, busy: true }));
    void flight
      .run(async () => {
        const tag = tagOf(label);
        try {
          const r = await api.postPositionDecision(instrumentId, {
            ...input,
            signal_ids: signals.map((x) => x.id),
          });
          o.onClose();
          o.onSaved?.();
          offer([r.decision.id], S.decisionSaved(tag));
        } catch (e) {
          toast(staleSignalText(e) ?? S.decisionFailedErr(errorText(e)), 5000);
        }
      })
      .finally(() => setForm((f) => ({ ...f, busy: false })));
  };
  return positionDialogProps({
    name: instName(io.inst),
    symbol: io.inst.symbol ?? null,
    signals,
    ctx,
    thesis: o.thesis,
    onClose: o.onClose,
    form: decisionFormProps({
      f: form,
      s: s0,
      instrumentId,
      ctx,
      pending: flight.busy,
      hideAck: true,
      onChange: (patch) => setForm((f) => ({ ...f, ...patch })),
      onSave: save,
      onCollapse: o.onClose,
      onOpenNotes: o.onOpenNotes,
    }),
  });
}
