// Rich-compatible styled text for small native CLI messages (not a table/markup engine).
import { unicodeDecimal } from "@cashu/domain";
import type { CommandIo } from "../tree.js";
import { cellSpans, wrapRanges } from "./consoleCells.js";
import { type ConsoleSpan, type ConsoleStyle, highlightConsole } from "./consoleHighlight.js";

export interface ConsoleOptions {
  readonly stream?: "stdout" | "stderr";
  readonly spans?: readonly ConsoleSpan[];
  /** Rich Console(highlight=False): preserve explicit spans but skip automatic syntax colors. */
  readonly highlight?: boolean;
}
/** Native rendering remains available on terminals with older width tables. */
export function supportsConsoleUnicode(_io: Pick<CommandIo, "tty">): boolean {
  return true;
}
/** Styles are explicit spans; callers must not silently strip arbitrary legacy Rich markup. */
export function consolePolicy(
  io: Pick<CommandIo, "tty" | "env">,
  stream: "stdout" | "stderr" = "stdout",
) {
  const terminal =
    io.tty.compatible ??
    (io.env.FORCE_COLOR === undefined ? io.tty[stream] : io.env.FORCE_COLOR !== "");
  const ansi = terminal && io.env.TERM !== "dumb" && io.env.TERM !== "unknown";
  const noColor = !!io.env.NO_COLOR;
  let width = io.tty.columns ?? 80;
  if (io.env.COLUMNS && /^\p{Nd}+$/u.test(io.env.COLUMNS)) {
    const parsed = Array.from(io.env.COLUMNS).reduce(
      (n, ch) => n * 10 + unicodeDecimal(ch.codePointAt(0) ?? 0),
      0,
    );
    width = parsed;
  }
  if (terminal && (io.env.TERM === "dumb" || io.env.TERM === "unknown")) width = 80;
  return { ansi, noColor, width };
}
function renderConsole(
  text: string,
  io: Pick<CommandIo, "tty" | "env">,
  options: ConsoleOptions = {},
): string {
  const { ansi, noColor, width } = consolePolicy(io, options.stream);
  if (width < 1) return "";
  // Rich markup styles override automatic highlighter colors on the same characters.
  const spans = [
    ...(options.highlight === false ? [] : highlightConsole(text)),
    ...(options.spans ?? []),
  ];
  const output: string[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    for (const [from, to] of wrapRanges(line, width)) {
      const start = offset + from;
      const end = offset + to;
      const cuts = new Set([start, end]);
      for (const span of spans) {
        if (span.start > start && span.start < end) cuts.add(span.start);
        if (span.end > start && span.end < end) cuts.add(span.end);
      }
      const points = [...cuts].sort((a, b) => a - b);
      let remaining = width;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i] ?? start;
        const b = points[i + 1] ?? end;
        let part = text.slice(a, b);
        const style: { -readonly [K in keyof ConsoleStyle]: ConsoleStyle[K] } = {};
        for (const span of spans)
          if (span.start <= a && span.end >= b) Object.assign(style, span.style);
        let length = 0;
        let cutoff = part.length;
        for (const cell of cellSpans(part)) {
          if (length + cell.width > remaining) {
            cutoff = cell.start;
            break;
          }
          length += cell.width;
        }
        if (cutoff !== part.length) {
          part = part.slice(0, cutoff) + " ".repeat(Math.max(0, remaining - length));
          length = remaining;
        }
        remaining -= length;
        const codes = [
          style.bold ? 1 : null,
          style.dim ? 2 : null,
          style.italic ? 3 : null,
          style.underline ? 4 : null,
          noColor ? null : (style.color ?? null),
        ].filter((n) => n !== null);
        output.push(
          ansi && codes.length > 0 && part ? `\u001b[${codes.join(";")}m${part}\u001b[0m` : part,
        );
      }
      output.push("\n");
    }
    offset += line.length + 1;
  }
  return output.join("");
}
export function printConsole(
  io: Pick<CommandIo, "tty" | "env" | "stdout" | "stderr">,
  text: string,
  options: ConsoleOptions = {},
): void {
  io[options.stream ?? "stdout"](renderConsole(text, io, options));
}
