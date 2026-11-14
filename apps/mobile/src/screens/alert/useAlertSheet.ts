// The alert sheet's hook: one fired signal live from the vault (what fired, when, the rule it came
// from), the position it is about (the public price, the value and share, the result against the
// owner's average cost), the thesis with the newest research verdict on it, the strategy's drawdown line
// and the owner's decision, plus the bell that tells this phone when the alert fires. Nothing is
// preselected: Save stays disabled until a choice; a decision is a journal note (Nothing / Buy more /
// Sell = held / bought / sold, never a quantity or a price, never a trade); "Decide later" acknowledges
// the signal, which brings it back in the weekly review. Both close the sheet once written; a refusal
// shows inline. Navigation stays in the route.
import type { core, IsoDate } from "@cashu/domain";
import { Decimal, Money } from "@cashu/domain";
import {
  markedAlerts,
  notificationPrefs,
  pricesFetchedAt,
  setAlertMarked,
  setNotificationPrefs,
} from "@cashu/store/device";
import {
  conditionalOwnerAcknowledge,
  type ReadySignals,
  signalsOwnerCommands,
} from "@cashu/store/investments/signals-screen";
import { useCommand, useQuery } from "@cashu/store-react";
import type { TagTone } from "@cashu/ui/native";
import { useUiEnv } from "@cashu/ui/native";
import { useRef, useState } from "react";
import { deviceTimeZone } from "../../services/investments";
import { useServices } from "../../services/ServicesProvider";
import { type SignalSubject, safeText, signalText } from "../investments/signalText";
import type { DisplayEnv } from "../today/display";
import { ACTION, RELATION, S } from "./Alert.strings";
import {
  averageCostOf,
  dayOf,
  dayText,
  momentText,
  ownPriceText,
  priceText,
  ratioText,
} from "./display";
import { drawdownLine, strategyMarkdown } from "./strategyLine";

type DecisionChoice = "held" | "bought" | "sold";
/** A verdict's colour: the tag tones of `@cashu/ui`. */
type Tone = Extract<TagTone, "negative" | "warning" | "info" | "positive">;

export type AlertFact =
  | {
      readonly kind: "text";
      readonly label: string;
      readonly value: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "money";
      readonly label: string;
      readonly value: Money;
      readonly detail?: string;
    }
  | {
      readonly kind: "percent";
      readonly label: string;
      /** A signed ratio (-0.126 = -12.6%). */
      readonly value: Decimal;
      readonly detail?: string;
    }
  /** Free text the owner wrote (the size plan): a few lines, not a figure. */
  | { readonly kind: "note"; readonly label: string; readonly value: string };

export type AlertSheetState =
  | { readonly kind: "missing"; onClose(): void }
  | {
      readonly kind: "ready";
      readonly tag: { readonly text: string; readonly tone: Tone };
      readonly title: string;
      /** "“CDR -8% in 5 sessions” · fired today 07:31". */
      readonly meta: string;
      readonly facts: readonly AlertFact[];
      readonly thesis: {
        readonly wrongIf: string | null;
        readonly researchLine: {
          readonly lead: string;
          readonly verdict: string;
          readonly tone: Tone;
          readonly text: string;
        } | null;
      } | null;
      readonly strategyLine: string | null;
      /**
       * "Tell this phone when it fires" (the bell): this device's mark on the alert behind the signal.
       * Null for a rule's signal and on a partner's phone (alerts are the owner's).
       */
      readonly tellPhone: { readonly on: boolean; onToggle(): void } | null;
      /** The decision already written (or "decide later"), when the signal has one. */
      readonly settled: string | null;
      /** Null once the signal is decided or closed: nothing left to decide here. */
      readonly decision: {
        readonly choice: DecisionChoice | null;
        onPick(choice: DecisionChoice): void;
        readonly reason: string;
        onReason(value: string): void;
        readonly canSave: boolean;
        readonly isSaving: boolean;
        readonly error: string | null;
        /** False once the signal was set aside for the review. */
        readonly canLater: boolean;
      } | null;
      onSave(): Promise<void>;
      onLater(): Promise<void>;
      onClose(): void;
    };

const OPEN = new Set(["active", "acknowledged"]);
const RELATIONS: Readonly<Record<string, Tone>> = {
  weakens: "negative",
  invalidates: "negative",
  supports: "positive",
  fulfills: "positive",
};

type Signal = ReadySignals["signals"][number];

/** An acknowledgement ("decide later") is a journal `held` with the reason `acknowledged`. */
export function isAcknowledgement(d: { readonly action: string; readonly reason: string | null }) {
  return d.action === "held" && d.reason === "acknowledged";
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** The fired fact in words ("CD Projekt fell 9.4% in 5 sessions"), else the signal sentence. */
export function signalTitle(
  signal: Pick<Signal, "messageCode" | "messageParams" | "message" | "kind" | "payload">,
  subject: SignalSubject,
  env: DisplayEnv,
): string {
  const { name, currency } = subject;
  const { locale } = env;
  const p = signal.messageParams ?? {};
  const change = num(p.change);
  const days = num(p.window_days);
  if (signal.messageCode === "alert.change_pct" && change !== null && days !== null) {
    const pct = ratioText(Math.abs(change), locale);
    return p.direction === "up" ? S.rose(name, pct, days) : S.fell(name, pct, days);
  }
  const level = num(p.level);
  if (level !== null && currency !== null) {
    const text = priceText(Decimal.fromFloat(level), currency, locale);
    if (signal.messageCode === "alert.price_below") return S.below(name, text);
    if (signal.messageCode === "alert.price_above") return S.above(name, text);
  }
  return signalText(signal, subject, env);
}

function tagOf(signal: Signal): { text: string; tone: Tone } {
  const tone: Tone =
    signal.polarity === "negative"
      ? "negative"
      : signal.polarity === "positive"
        ? "info"
        : "warning";
  if (signal.alert === null) return { text: S.tagRule, tone };
  if (signal.polarity === "negative") return { text: S.tagRisk, tone };
  if (signal.polarity === "positive") return { text: S.tagOpportunity, tone };
  return { text: S.tagAlert, tone };
}

export function useAlertSheet(args: {
  /** The vault the sheet was opened with (`usePinnedVault`): every write goes there, never to a later profile. */
  readonly vault: string;
  readonly gid: string;
  readonly lang: core.UiLang;
  readonly today: IsoDate;
  /** The moment the day was read (ISO instant); the sources' clock wins when bound. */
  readonly now: string;
  close(): void;
}): AlertSheetState {
  const ui = useUiEnv();
  const { locale } = ui;
  const env: DisplayEnv = { locale, privacy: ui.privacy, bananas: ui.bananas ?? null };
  const { moneyQueries, profiles } = useServices();
  const { today, lang } = args;
  const screen = useQuery(moneyQueries.investments.signals, {
    now: args.now,
    today,
    timeZone: deviceTimeZone(),
    lang,
    privacy: false,
  });
  const portfolio = useQuery(moneyQueries.investments.portfolio, { today, lang });
  const signal =
    screen.status === "ready" ? screen.signals.find((s) => s.gid === args.gid) : undefined;
  const instrumentGid = signal?.instrument ?? null;
  const research = useQuery(moneyQueries.investments.research.asset, {
    today,
    lang,
    instrument: instrumentGid ?? "",
  });
  const markdown = useQuery(strategyMarkdown);
  const { vault } = args;
  const fetchedAt = useQuery(pricesFetchedAt, { vault });
  const marked = useQuery(markedAlerts, { vault });
  const prefs = useQuery(notificationPrefs, { vault });
  const mark = useCommand(setAlertMarked, { vault: args.vault });
  const choose = useCommand(setNotificationPrefs, { vault: args.vault });
  const owner = profiles.find((p) => p.vault === vault)?.role !== "partner";
  const decidePosition = useCommand(signalsOwnerCommands.positionDecision, { vault: args.vault });
  const decideSignal = useCommand(signalsOwnerCommands.decide, { vault: args.vault });
  const acknowledge = useCommand(conditionalOwnerAcknowledge, { vault: args.vault });
  const [choice, setChoice] = useState<DecisionChoice | null>(null);
  const [reason, setReason] = useState("");
  const [failed, setFailed] = useState(false);
  // The pending flags reach the buttons only on the next render: a second tap before that must not
  // journal a second decision for the same signal.
  const busy = useRef(false);
  if (screen.status !== "ready" || signal === undefined)
    return { kind: "missing", onClose: args.close };

  const instrument = screen.instruments.find((i) => i.id === instrumentGid) ?? null;
  const name = instrument?.name ?? signal.instrumentLabel ?? "";
  const alert = screen.alerts.find((a) => a.gid === signal.alert) ?? null;
  const thesis = screen.theses.find((t) => t.instrument === instrumentGid) ?? null;
  const position =
    portfolio.status === "ready" && instrumentGid !== null
      ? (portfolio.positions.positions.find((p) => p.instrument.id === instrumentGid) ?? null)
      : null;
  const baseCurrency = portfolio.status === "ready" ? portfolio.positions.base_currency : null;

  // What fired and when.
  // The alert's title or the engine's text may name the owner's bucket or carry amounts.
  const rule = safeText(alert?.title ?? signal.message, env);
  const fired = momentText(alert?.lastTriggeredAt ?? signal.firstSeenAt, today, locale);
  const meta = fired.today
    ? S.firedToday(rule, fired.time)
    : S.firedOn(rule, fired.day, fired.time);

  // The facts: the public price, the position, the result and the size plan.
  const facts: AlertFact[] = [];
  if (position?.price != null) {
    const currency = position.price_currency ?? instrument?.currency ?? baseCurrency ?? "PLN";
    const fetched = fetchedAt;
    facts.push({
      kind: "text",
      label: S.price,
      value: priceText(position.price, currency, locale),
      detail:
        position.price_date === today && fetched !== null && dayOf(fetched) === today
          ? S.priceFrom(momentText(fetched, today, locale).time)
          : S.closeOn(dayText(position.price_date ?? today, locale)),
    });
  }
  if (position?.value != null && baseCurrency !== null)
    facts.push({
      kind: "money",
      label: S.yourPosition,
      value: new Money(position.value, baseCurrency),
      ...(position.weight === null
        ? {}
        : { detail: S.ofPortfolio(ratioText(position.weight, locale)) }),
    });
  if (position?.unrealized_pct != null) {
    const cost = averageCostOf(position);
    facts.push({
      kind: "percent",
      label: S.result,
      value: Decimal.fromFloat(position.unrealized_pct),
      ...(cost === null
        ? {}
        : { detail: S.averageCost(ownPriceText(cost.value, cost.currency, env)) }),
    });
  }
  if (thesis?.sizePlan) facts.push({ kind: "note", label: S.sizePlan, value: thesis.sizePlan });

  // The newest research note with a verdict on the thesis.
  const notes = ("notes" in research ? research.notes : undefined) ?? [];
  const verdict =
    notes
      .filter((n) => !n.dismissed && RELATIONS[n.thesis_relation] !== undefined)
      .sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""))[0] ?? null;
  const relation = verdict === null ? undefined : RELATIONS[verdict.thesis_relation];

  // What was decided already (the newest decision covering the signal).
  const latest =
    [...signal.decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const later = latest !== null && isAcknowledgement(latest);
  const decided = latest !== null && !later;
  const open = OPEN.has(signal.status);
  const settled =
    latest === null
      ? null
      : later
        ? S.laterNoted
        : S.noted(
            (ACTION as Record<string, string | undefined>)[latest.action] ?? latest.action,
            dayText(dayOf(latest.createdAt), locale),
          );

  const done = (outcome: { kind: string }) => {
    if (outcome.kind === "completed") args.close();
    else setFailed(true);
  };
  const once = async (write: () => Promise<{ kind: string }>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      setFailed(false);
      done(await write());
    } finally {
      busy.current = false;
    }
  };
  const save = async () => {
    if (choice === null || !open || decided) return;
    const text = reason.trim() === "" ? null : reason.trim();
    await once(() =>
      instrumentGid === null
        ? decideSignal.run({ signal: signal.gid, action: choice, reason: text })
        : decidePosition.run({
            instrument: instrumentGid,
            signals: [signal.gid],
            action: choice,
            reason: text,
          }),
    );
  };
  const setAside = async () => {
    if (!open || latest !== null) return;
    await once(() => acknowledge.run({ signal: signal.gid }));
  };
  const isSaving = decidePosition.isPending || decideSignal.isPending || acknowledge.isPending;

  return {
    kind: "ready",
    tag: tagOf(signal),
    title: signalTitle(signal, { name, currency: instrument?.currency ?? null, baseCurrency }, env),
    meta,
    facts,
    thesis:
      thesis === null
        ? null
        : {
            wrongIf: thesis.invalidation,
            researchLine:
              verdict === null || relation === undefined
                ? null
                : {
                    lead: S.researchOn(
                      dayText(dayOf(verdict.observed_at ?? verdict.created_at ?? args.now), locale),
                    ),
                    verdict: RELATION[verdict.thesis_relation as keyof typeof RELATION],
                    tone: relation,
                    text: verdict.title,
                  },
          },
    strategyLine: drawdownLine(markdown),
    tellPhone:
      signal.alert === null || !owner
        ? null
        : {
            on: marked.includes(signal.alert),
            onToggle: () => {
              const alert = signal.alert;
              if (alert === null) return;
              const on = !marked.includes(alert);
              void mark.run({ vault, alert, marked: on });
              // Marking is asking to be told: the "marked alerts" choice turns on with it.
              if (on && !prefs.alertsFired)
                void choose.run({ vault, prefs: { alertsFired: true } });
            },
          },
    settled,
    decision:
      open && !decided
        ? {
            choice,
            onPick: (c) => {
              setChoice(c);
              setFailed(false);
            },
            reason,
            onReason: setReason,
            canSave: choice !== null && !isSaving,
            isSaving,
            error: failed ? S.couldNotSave : null,
            canLater: !later,
          }
        : null,
    onSave: save,
    onLater: setAside,
    onClose: args.close,
  };
}
