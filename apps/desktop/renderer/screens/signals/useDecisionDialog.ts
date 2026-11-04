import { D } from "@cashu/domain";
import { views } from "@cashu/domain/investments";
import { normalizeNumberInput } from "@cashu/i18n";
import {
  conditionalOwnerAcknowledge,
  type ReadySignals,
  saveSignalGroup,
  signalsOwnerCommands,
} from "@cashu/store/investments/signals-screen";
import { useCommand } from "@cashu/store-react";
import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useRef } from "react";
import type { useDurableCommands } from "../useDurableCommand.js";
import type { SignalGroup } from "./presentation.js";
import {
  decisionHeader,
  estimateView,
  FALLBACK_BASE_CURRENCY,
  suggestedAction,
} from "./signalModels.js";
import type { SignalsFeedbackApi } from "./useSignalsFeedback.js";

type DecisionAction = "held" | "bought" | "sold" | "other";
function decisionDefaults(action: string, quantity: string, price: string, currency: string) {
  return { action, account: "", quantity, price, currency, reason: "" };
}

/** The decision dialog of one signal group: suggestion, live estimate and the save. */
export function useDecisionDialog(args: {
  readonly data: ReadySignals | null;
  readonly privacy: boolean;
  readonly group: SignalGroup | null;
  readonly nextDeposit: string | null;
  readonly feedback: SignalsFeedbackApi;
  readonly durable: ReturnType<typeof useDurableCommands>;
  readonly onClose: () => void;
}) {
  const { data, privacy, group, feedback, durable } = args;
  const decide = useCommand(signalsOwnerCommands.decide);
  const positionDecision = useCommand(signalsOwnerCommands.positionDecision);
  const acknowledge = useCommand(conditionalOwnerAcknowledge);
  const valuation = data?.context.status === "ready" ? data.context : null;
  const position =
    valuation !== null && group?.instrument != null
      ? (valuation.positions.positions.find((row) => row.instrument.id === group.instrument) ??
        null)
      : null;
  const base = valuation?.overview.base_currency ?? FALLBACK_BASE_CURRENCY;
  const total = valuation?.overview.kpis.value.total ?? D("0");
  const suggestion = views.decisionSuggestion({
    signal: group?.live[0] ?? null,
    position:
      position === null
        ? null
        : {
            quantity: position.quantity,
            price: position.price,
            priceCurrency: position.price_currency ?? position.instrument.currency,
          },
    total,
    base,
  });
  const defaults = decisionDefaults(
    suggestedAction(suggestion.choice),
    suggestion.quantity?.toString() ?? "",
    suggestion.price?.toString() ?? "",
    suggestion.currency,
  );
  const form = useForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      if (data === null || group === null || feedback.isBusy() || privacy) return;
      const members = group.live;
      const [first, ...rest] = members;
      if (!first) return;
      feedback.setNotice(null);
      const fields = {
        action: value.action as DecisionAction,
        account: value.account || null,
        quantity: normalized(value.quantity),
        price: normalized(value.price),
        currency: value.currency || null,
        reason: value.reason.trim() || null,
      };
      await feedback.exclusive(
        "decision",
        async () => {
          if (group.instrument !== null) {
            const result = await durable.run(`position:${group.key}`, positionDecision, {
              instrument: group.instrument,
              signals: members.map((row) => row.gid),
              ...fields,
            });
            if (result.kind === "completed") {
              feedback.setUndoIds([result.value.decision]);
              feedback.setNotice("saved");
              args.onClose();
            } else feedback.failed(result);
            return;
          }
          const outcome = await saveSignalGroup(
            [
              () => durable.run(`decide:${first.gid}`, decide, { signal: first.gid, ...fields }),
              ...rest.map(
                (row) => () =>
                  durable.run(`ack:${row.gid}`, acknowledge, {
                    signal: row.gid,
                    reason: `decision: ${fields.action}`,
                  }),
              ),
            ],
            feedback.isActive,
          );
          if (!feedback.isActive()) return;
          feedback.grouped(outcome);
          if (outcome.status === "saved" || outcome.status === "skipped") args.onClose();
        },
        { clearRefusal: true },
      );
    },
  });
  const values = useStore(form.store, (state) => state.values);
  // A newly opened group starts from its own suggestion; edits within the same group are kept.
  const initialized = useRef<string | null>(null);
  const key = group?.key ?? null;
  useEffect(() => {
    if (key === null) {
      initialized.current = null;
      return;
    }
    if (initialized.current === key) return;
    initialized.current = key;
    form.reset(defaults);
  }, [key, form, defaults]);
  const bucket = valuation?.allocation.buckets.find((row) => row.bucket_id === position?.bucket);
  const estimate =
    values.action === "bought" || values.action === "sold"
      ? views.decisionEstimate({
          side: values.action === "bought" ? "buy" : "sell",
          quantity: decimalOrNull(values.quantity),
          price: decimalOrNull(values.price),
          currency: values.currency || suggestion.currency,
          base,
          total,
          bucket:
            bucket === undefined
              ? null
              : {
                  value: bucket.value,
                  target: bucket.target,
                  driftPp: bucket.drift_pp,
                  generic: bucket.generic,
                },
        })
      : null;
  return {
    open: group !== null,
    ...decisionHeader(group),
    form,
    suggestedQuantity: suggestion.quantity,
    quantityUnavailable: suggestion.quantityUnavailable !== null,
    estimate: estimate === null ? null : estimateView(estimate),
    /** The first thesis of the group's instrument, shown as context. */
    thesis: data?.theses.find((thesis) => thesis.instrument === group?.instrument) ?? null,
    accounts: data?.accounts ?? [],
    /** A contribution gap is decided against the next planned deposit. */
    nextDeposit: group?.primary?.kind === "contribution_gap" ? args.nextDeposit : null,
    busy: feedback.state.busy,
    onClose: args.onClose,
  };
}
export type DecisionDialogState = ReturnType<typeof useDecisionDialog>;

function normalized(text: string): string | null {
  const result = normalizeNumberInput(text);
  return result.trim() ? result : null;
}
/** A half-typed number has no estimate yet; that is not an error. */
function decimalOrNull(text: string) {
  try {
    const value = normalized(text);
    return value === null ? null : D(value);
  } catch {
    return null;
  }
}
