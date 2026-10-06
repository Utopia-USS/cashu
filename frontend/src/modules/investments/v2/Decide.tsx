// One decision per position (design/v3/asset-detail/asset-detail.md 7.2, owner QA Q25): the asset header's
// `Zanotuj decyzję` opens this centered dialog over the page or the drawer. It lists the open signals as context
// (every listed signal is covered by the save; no checkboxes), the thesis line, then the decision form. One save
// writes one decision linked to every open signal (`useDecisionWriter`: the position endpoint, else the home's
// fan-out on older servers); one toast, one `Cofnij`. Rendered through a portal at the end of `body`, so the
// asset drawer under it sees it as the top dialog (Esc closes this one only, focus returns to the button).
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useModal } from "../../../ui";
import { PolDot } from "../../../widgets";
import type { Thesis } from "../api";
import type { SignalV2 } from "./api";
import { polarityOf, signalFact } from "./logic";
import { Age, DecisionForm, Fact1, longText, type SignalsCtx, signalAge, useDecisionWriter } from "./Signals";

const MAX_LINES = 5;

export function PositionDecisionDialog({ instrumentId, name, symbol, signals, ctx, thesis, onClose, onSaved }: {
  instrumentId: number;
  name: string;
  symbol: string | null;
  /** The undecided open signals of the instrument (byTime order): all of them are covered by the decision. */
  signals: SignalV2[];
  ctx: SignalsCtx;
  thesis: Thesis | null;
  /** Kept for the note's contract (held vs watched); the form finds the position itself. */
  held: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The opener (the header's `Zanotuj decyzję`), captured on the first render: the form focuses its own control
  // in an effect that runs before the modal's, so the modal would record that control as its opener.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  useEffect(() => () => {
    const el = opener.current;
    requestAnimationFrame(() => { if (el && document.contains(el)) el.focus({ preventScroll: true }); });
  }, []);
  useModal(ref, true, onClose, { focus: "first" });
  // The selected action button, as in the home's form (the modal's own focus lands on the first control first).
  useEffect(() => { requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(".seg button.on")?.focus()); }, []);
  const writer = useDecisionWriter(ctx);
  const lines = signals.slice(0, MAX_LINES);
  const more = signals.length - lines.length;
  const th = thesis?.exit_plan ? ["Plan wyjścia", thesis.exit_plan] : thesis?.thesis ? ["Teza", thesis.thesis] : null;
  const decide = async (input: Parameters<typeof writer.save>[2], label: string) => {
    const r = await writer.save(instrumentId, signals, input, label);
    if (r !== "stay") onClose();
    if (r === "saved") onSaved?.();
  };
  return createPortal(
    <>
      <div className="ascrim over" onClick={onClose} aria-hidden />
      <div className="ddlg" role="dialog" aria-modal="true" aria-label={`Decyzja · ${name}`} ref={ref} tabIndex={-1}>
        <div className="dh">
          <strong>Decyzja</strong> ·{symbol && symbol !== name ? <><span className="tk">{symbol}</span><span className="nmm">{name}</span></> : <span className="tk">{name}</span>}
          <span className="spacer" />
          <button className="icon-btn" title="Zamknij (Esc)" aria-label="Zamknij" onClick={onClose}>✕</button>
        </div>
        <div className="db">
          <div className="dctx">
            {signals.length ? <div className="kick">otwarte sygnały</div> : <div className="kick">bez otwartych sygnałów</div>}
            {lines.map((s) => (
              <div key={s.id} className="ln" title={longText(s, ctx)}>
                <PolDot polarity={polarityOf(s)} />
                <span><Fact1 f={signalFact(s)} /> <Age a={signalAge(s, ctx)} /></span>
              </div>
            ))}
            {more > 0 && <div className="more">+{more}</div>}
          </div>
          {th && <div className="th"><b>{th[0]}</b> · {th[1]}</div>}
          <DecisionForm s={signals[0] ?? null} instrumentId={instrumentId} ctx={ctx} pending={writer.busy} hideAck onCollapse={onClose} onDecide={decide} />
        </div>
      </div>
    </>,
    document.body,
  );
}
