// P2 strategy hints (design/v3/strategy-hints/strategy-hints.md 2): the main hint as an inert chip. Severity by
// contrast, never a P/L colour: `rule` = warn solid, `review` = ink outline, `info` = muted outline. The words come
// from the FE maps (logic.ts `hintChip` / `hintLine`); an unknown code renders nothing.
import { useId } from "react";
import type { Hint } from "../api";
import { hintChip, hintCls, hintLine } from "./logic";

/** `all` (the asset header): every hint, main first: the chip becomes focusable and describes all of them (a visually
 * hidden list) besides the native multi-line title, so keyboard and screen-reader users reach hints 2..n too. */
export function HintChip({ hint, held, title, all }: { hint: Hint; held: boolean; title?: string; all?: Hint[] }) {
  const id = useId();
  const chip = hintChip(hint, held);
  if (!chip) return null;
  const lines = all?.map((h) => hintLine(h, held)).filter(Boolean) ?? [];
  const cls = `hint ${hintCls(hint.severity)}`;
  if (!lines.length) return <span className={cls} data-hint={hint.code} title={title ?? hintLine(hint, held)}><span>{chip}</span></span>;
  return (
    <>
      <span className={cls} data-hint={hint.code} title={title ?? lines.join("\n")} tabIndex={0} aria-describedby={id}><span>{chip}</span></span>
      <span className="sr-only" id={id}><span>Strategia: </span>{lines.map((l, k) => <span key={k}>{l}{k < lines.length - 1 ? "; " : ""}</span>)}</span>
    </>
  );
}

/** The main hint the FE can word (payload order: the BE puts the main one first). */
export function mainHint(hints: Hint[] | null | undefined, held: boolean): Hint | null {
  return (hints ?? []).find((h) => hintChip(h, held) !== "") ?? null;
}
