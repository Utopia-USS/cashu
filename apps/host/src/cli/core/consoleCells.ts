// Rich's Unicode cell measurement and wrapping: financial values never enter this presentation code.
import { PY_WS } from "@cashu/domain";
import data from "./consoleCells.json" with { type: "json" };

const rightSpaces = new RegExp(`[${PY_WS}]+$`, "u");
const rstrip = (text: string): string => text.replace(rightSpaces, "");
const widened = new Set(data.narrowToWide);
export interface CellSpan {
  readonly start: number;
  readonly end: number;
  readonly width: number;
}
function charWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if ((cp > 0 && cp < 32) || (cp >= 0x7f && cp < 0xa0)) return 0;
  let low = 0;
  let high = data.widths.length - 1;
  while (low <= high) {
    const at = (low + high) >>> 1;
    const row = data.widths[at];
    if (row === undefined) break;
    const [start = 0, end = 0, width = 1] = row;
    if (cp < start) high = at - 1;
    else if (cp > end) low = at + 1;
    else return width;
  }
  return 1;
}
/** Spans use UTF-16 offsets to align with JS regexp capture indices. */
export function cellSpans(text: string): CellSpan[] {
  const spans: CellSpan[] = [];
  let lastMeasured = "";
  for (let at = 0; at < text.length; ) {
    const cp = text.codePointAt(at) ?? 0;
    const char = String.fromCodePoint(cp);
    let end = at + char.length;
    const previous = spans[spans.length - 1];
    if (char === "\u200d" && previous !== undefined) {
      if (end < text.length) end += String.fromCodePoint(text.codePointAt(end) ?? 0).length;
      spans[spans.length - 1] = { ...previous, end };
    } else if (char === "\ufe0f" && previous !== undefined) {
      const extra = widened.has(lastMeasured) ? 1 : 0;
      spans[spans.length - 1] = { ...previous, end, width: previous.width + extra };
      if (extra) lastMeasured = "";
    } else {
      const width = charWidth(char);
      if (width !== 0) lastMeasured = char;
      if (width === 0 && previous !== undefined) spans[spans.length - 1] = { ...previous, end };
      else spans.push({ start: at, end, width });
    }
    at = end;
  }
  return spans;
}
const cellLength = (text: string): number =>
  cellSpans(text).reduce((sum, span) => sum + span.width, 0);
const words = new RegExp(`[${PY_WS}]*[^${PY_WS}]+[${PY_WS}]*`, "gu");
/** Rich divide_line: spaces follow their word and are cropped only when beyond the width. */
export function wrapRanges(text: string, width: number): readonly (readonly [number, number])[] {
  const breaks: number[] = [0];
  let offset = 0;
  for (const match of text.matchAll(words)) {
    const word = match[0];
    let start = match.index;
    const length = cellLength(rstrip(word));
    if (width - offset >= length) offset += cellLength(word);
    else if (length > width) {
      const lines: { start: number; end: number; width: number }[] = [];
      let lineStart = 0;
      let size = 0;
      for (const span of cellSpans(word)) {
        if (size + span.width > width) {
          lines.push({ start: lineStart, end: span.start, width: size });
          lineStart = span.start;
          size = 0;
        }
        size += span.width;
      }
      if (size) lines.push({ start: lineStart, end: word.length, width: size });
      for (const [index, line] of lines.entries()) {
        if (start) breaks.push(start);
        if (index === lines.length - 1) offset = line.width;
        else start += line.end - line.start;
      }
    } else if (offset && start) {
      breaks.push(start);
      offset = cellLength(word);
    }
  }
  breaks.push(text.length);
  return breaks.slice(0, -1).map((start, i) => {
    let end = breaks[i + 1] ?? text.length;
    const line = text.slice(start, end);
    const excess = Array.from(line).length - width;
    if (excess > 0) {
      const spaces = Array.from(line).length - Array.from(rstrip(line)).length;
      end -= Math.min(excess, spaces);
    }
    return [start, end];
  });
}
