// The old v2 api.ts writes the ported Signals / Decide / Alerts / Watchlist / Journal code calls, on the native
// owner commands and UI actions: legacy numbers in (gidOf), the old `{decision: {id}}` / Alert shapes out, a
// failure thrown as the error the old request raised (legacy/outcome.ts). The live queries carry the readback,
// so there is no reload: `onChanged` of the old code has nothing left to refetch.
import {
  type InstrumentSearchResult,
  type SignalsWatchTarget,
  signalsAlertCommands,
  signalsOwnerCommands,
  signalsRemoveWatch,
  signalsSearch,
  signalsSnooze,
  signalsWatch,
} from "@cashu/store/investments/signals-screen";
import { useCommand, useUiAction } from "@cashu/store-react";
import type { SearchResult, WatchInput } from "@cashu/ui-logic/investments/v2/types";
import { gidOf, legacyId, wire } from "../investments/home/legacyWire.js";
import { useDurableCommands } from "../useDurableCommand.js";
import { OutcomeError, settled, settledAction } from "./legacy/outcome.js";
import { snoozeInstant } from "./signalModels.js";

const alertCommands = signalsAlertCommands();

/** The old `DecisionInput` (api.ts). */
export interface DecisionInput {
  action: string;
  reason: string | null;
  quantity?: number | null;
  price?: number | null;
  currency?: string | null;
  account_id?: number | null;
}
type Action = "bought" | "sold" | "held" | "ignored" | "other";
type Saved = { decision: { id: number } };

const need = (id: number | null | undefined): string => {
  const gid = gidOf(id);
  if (gid === null) throw new OutcomeError("not_found", "no_signal");
  return gid;
};
const decimal = (n: number | null | undefined): string | null =>
  n == null || !Number.isFinite(n) ? null : String(n);
const fields = (input: DecisionInput) => ({
  action: input.action as Action,
  reason: input.reason,
  account: gidOf(input.account_id ?? null),
  quantity: decimal(input.quantity),
  price: decimal(input.price),
  currency: input.currency ?? null,
});
const saved = (r: { decision: string | null }): Saved => ({
  decision: { id: r.decision === null ? 0 : legacyId(r.decision) },
});
/** An alert patch / input with the old snake_case keys, in the command's camelCase. */
const ALERT_KEYS: Readonly<Record<string, string>> = {
  cooldown_days: "cooldownDays",
  expires_at: "expiresAt",
  expires_in_days: "expiresInDays",
  snoozed_until: "snoozedUntil",
};
const camel = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [ALERT_KEYS[k] ?? k, v]));

export function useLegacySignalsApi() {
  const durable = useDurableCommands();
  const decide = useCommand(signalsOwnerCommands.decide);
  const position = useCommand(signalsOwnerCommands.positionDecision);
  const acknowledge = useCommand(signalsOwnerCommands.acknowledge);
  const undo = useCommand(signalsOwnerCommands.undo);
  const removeAlert = useCommand(signalsOwnerCommands.deleteAlert);
  const restore = useCommand(signalsOwnerCommands.restoreAlert);
  const createAlert = useCommand(alertCommands.create);
  const updateAlert = useCommand(alertCommands.update);
  const snooze = useUiAction(signalsSnooze);
  const watch = useUiAction(signalsWatch);
  const unwatch = useUiAction(signalsRemoveWatch);
  const search = useUiAction(signalsSearch);

  return {
    /** `POST signals/{id}/decision`. */
    postDecision: async (signalId: number, input: DecisionInput): Promise<Saved> => {
      const signal = need(signalId);
      return saved(
        await settled(durable.run(`decide:${signal}`, decide, { signal, ...fields(input) })),
      );
    },
    /** `POST positions/{id}/decision` linked to `signal_ids`. */
    postPositionDecision: async (
      instrumentId: number,
      input: DecisionInput & { signal_ids: number[] },
    ): Promise<Saved> => {
      const instrument = need(instrumentId);
      const signals = input.signal_ids.map(need);
      return saved(
        await settled(
          durable.run(`position:${instrument}`, position, {
            instrument,
            signals,
            ...fields(input),
          }),
        ),
      );
    },
    /** `POST signals/{id}/acknowledge`. */
    postAcknowledge: async (signalId: number, reason?: string | null): Promise<Saved> => {
      const signal = need(signalId);
      return saved(
        await settled(
          durable.run(`ack:${signal}`, acknowledge, { signal, reason: reason ?? null }),
        ),
      );
    },
    /** `POST signals/{id}/snooze` (until a local day, null = wake now). */
    postSnooze: async (signalId: number, until: string | null): Promise<void> => {
      const signal = need(signalId);
      await settledAction(
        snooze.run({ signal, until: until === null ? null : snoozeInstant(until) }),
      );
    },
    /** `DELETE decisions/{id}` within the 15 minutes. */
    deleteDecision: async (decisionId: number): Promise<void> => {
      const decision = gidOf(decisionId);
      if (decision === null) throw new OutcomeError("not_found", "no_decision");
      await settled(durable.run(`undo:${decision}`, undo, { decision }));
    },
    /** `DELETE alerts/{id}` (soft, restorable for 15 minutes). */
    deleteAlert: async (alertId: number): Promise<void> => {
      const alert = need(alertId);
      await settled(durable.run(`alert-delete:${alert}`, removeAlert, { alert }));
    },
    /** `POST alerts/{id}/restore`. */
    restoreAlert: async (alertId: number): Promise<void> => {
      const alert = need(alertId);
      await settled(durable.run(`alert-restore:${alert}`, restore, { alert }));
    },
    /** `PATCH alerts/{id}` with the changed fields only. */
    patchAlert: async (alertId: number, patch: Record<string, unknown>): Promise<void> => {
      const alert = need(alertId);
      await settled(
        durable.run(`alert-update:${alert}`, updateAlert, { alert, changes: camel(patch) }),
      );
    },
    /** `POST alerts`; answers the saved title (the old response's `title`, all the form reads). */
    postAlert: async (
      body: Record<string, unknown> & { instrument_id: number | null; title: string },
    ) => {
      const { instrument_id, ...rest } = body;
      const input = { ...camel(rest), instrument: gidOf(instrument_id) } as Parameters<
        typeof createAlert.run
      >[0];
      await settled(durable.run("alert-create", createAlert, input));
      return { title: body.title };
    },
    /** `POST watchlist`: answers the old add response (`restored`, `created_instrument`, the coded warnings). */
    postWatch: async (input: WatchInput & { note?: string | null; tags?: string[] | null }) => {
      const target: SignalsWatchTarget = input.pick
        ? {
            kind: "pick",
            yahooSymbol: input.pick.yahoo_symbol,
            ticker: input.pick.ticker ?? null,
            name: input.pick.name ?? null,
            assetClass: input.pick.asset_class ?? null,
            mic: input.pick.mic ?? null,
            isin: input.pick.isin ?? null,
          }
        : input.instrument_id != null
          ? { kind: "instrument", gid: need(input.instrument_id) }
          : { kind: "text", text: input.symbol_or_isin ?? "" };
      const r = await settledAction(
        watch.run({
          target,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
        }),
      );
      if (!r.ok) throw new OutcomeError(r.reason, r.reason);
      return {
        instrumentId: legacyId(r.value.instrument),
        restored: r.value.restored,
        created_instrument: r.value.createdInstrument,
        warning_codes: r.value.warnings.map((w) => ({
          code: w.code,
          params: { ...w.params } as Record<string, unknown>,
          message: w.code,
        })),
      };
    },
    /** `DELETE watchlist/{id}` (the watch row). */
    deleteWatch: async (watchId: number): Promise<void> => {
      const item = gidOf(watchId);
      if (item === null) throw new OutcomeError("not_found", "no_item");
      await settledAction(unwatch.run({ item }));
    },
    /** `GET instruments/search?q=` (local and online hits in one answer). */
    searchInstruments: async (query: string): Promise<SearchResult> =>
      wire<SearchResult>(await settledAction<InstrumentSearchResult>(search.run({ query }))),
  };
}
export type LegacySignalsApi = ReturnType<typeof useLegacySignalsApi>;
