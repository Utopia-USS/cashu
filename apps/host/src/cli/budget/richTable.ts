// The plain-cell Rich HEAVY_HEAD subset: measured widths, collapse, wrapping and justification.
import { PY_WS } from "@cashu/domain";
import { consolePolicy } from "../core/console.js";
import { cellSpans, wrapRanges } from "../core/consoleCells.js";
import type { CommandIo } from "../tree.js";

export interface TableColumn {
  readonly header: string;
  readonly justify?: "left" | "right";
}
export interface TableOptions {
  /** Zero-based body row and column positions styled as Rich Text(bold=True). */
  readonly boldCells?: readonly { readonly row: number; readonly column: number }[];
}
const rightSpaces = new RegExp(`[${PY_WS}]+$`, "u");
function width(text: string): number {
  return cellSpans(text).reduce((n, cell) => n + cell.width, 0);
}
function plain(text: string): boolean {
  return !Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) < 32 || ch.codePointAt(0) === 127);
}
function styled(text: string, code: number, enabled: boolean): string {
  return enabled && text ? `\u001b[${code}m${text}\u001b[0m` : text;
}
/** Rich set_cell_size: a wide character crossing the cut becomes a blank cell. */
function crop(text: string, size: number): string {
  let used = 0,
    end = 0;
  for (const span of cellSpans(text)) {
    if (used + span.width > size) break;
    used += span.width;
    end = span.end;
  }
  return text.slice(0, end) + " ".repeat(Math.max(0, size - used));
}
function fit(text: string, size: number, side: "left" | "right"): string {
  let value = side === "right" ? text.replace(rightSpaces, "") : text;
  if (width(value) > size) value = `${crop(value, size - 1)}…`;
  const spaces = " ".repeat(Math.max(0, size - width(value)));
  return side === "right" ? spaces + value : value + spaces;
}
/** ratio_reduce uses Python round(), including even ties, and updates the remaining ratio. */
function roundEven(value: number): number {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}
function reduce(
  total: number,
  ratios: readonly number[],
  maximums: readonly number[],
  values: readonly number[],
): number[] {
  const active = ratios.map((ratio, i) => (maximums[i] ? ratio : 0));
  let remaining = total,
    totalRatio = active.reduce((n, ratio) => n + ratio, 0);
  return values.map((value, i) => {
    const ratio = active[i] ?? 0;
    if (!ratio || totalRatio <= 0) return value;
    const distributed = Math.min(maximums[i] ?? 0, roundEven((ratio * remaining) / totalRatio));
    remaining -= distributed;
    totalRatio -= ratio;
    return value - distributed;
  });
}
/** Table._calculate_column_widths/_collapse_widths, for auto-width, wrappable plain columns. */
function columnWidths(
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  available: number,
): number[] | null {
  if (available < columns.length * 3) return null;
  const natural = columns.map((column, i) =>
    Math.min(
      available,
      Math.max(width(column.header), ...rows.map((row) => width(row[i] ?? ""))) + 2,
    ),
  );
  let values = [...natural];
  let excess = values.reduce((n, value) => n + value, 0) - available;
  while (excess > 0) {
    const largest = Math.max(...values);
    const second = Math.max(0, ...values.filter((value) => value !== largest));
    const difference = largest - second;
    if (!difference) return null;
    values = reduce(
      excess,
      values.map((value) => (value === largest ? 1 : 0)),
      values.map(() => Math.min(excess, difference)),
      values,
    );
    excess = values.reduce((n, value) => n + value, 0) - available;
  }
  values = values.map((value, i) => Math.min(natural[i] ?? 0, value));
  return values.some((value) => value < 3) ? null : values;
}
function cellLines(text: string, size: number, justify: "left" | "right"): string[] {
  // Rich columns default to overflow="ellipsis", so overlong words are cropped, not folded.
  return wrapRanges(text, size, false).map(([start, end]) =>
    fit(text.slice(start, end), size, justify),
  );
}

/** Null is an explicit unsupported control/extremely narrow layout, before any output. */
export function richTable(
  io: CommandIo,
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  title?: string,
  options: TableOptions = {},
): string | null {
  if (!columns.length || rows.some((row) => row.length !== columns.length)) return null;
  if ([title ?? "", ...columns.map((c) => c.header), ...rows.flat()].some((text) => !plain(text)))
    return null;
  const policy = consolePolicy(io);
  if (!Number.isSafeInteger(policy.width)) return null;
  const widths = columnWidths(columns, rows, policy.width - columns.length - 1);
  if (widths === null) return null;
  const sizes = widths.map((value) => value - 2);
  const total = widths.reduce((n, value) => n + value, 0) + columns.length + 1;
  const border = (left: string, join: string, right: string, line: string) =>
    `${left}${widths.map((n) => line.repeat(n)).join(join)}${right}\n`;
  const bold = new Set((options.boldCells ?? []).map(({ row, column }) => `${row}:${column}`));
  const styleBody = (content: string, row: number, column: number) => {
    if (!bold.has(`${row}:${column}`) || !policy.ansi) return content;
    const leading = /^\s*/u.exec(content)?.[0] ?? "";
    const trailing = /\s*$/u.exec(content)?.[0] ?? "";
    const body = content.slice(leading.length, content.length - trailing.length);
    return `${leading}${styled(body, 1, true)}${trailing}`;
  };
  let out = "";
  if (title)
    for (const [start, end] of wrapRanges(title, total)) {
      const text = title.slice(start, end).replace(rightSpaces, "");
      const content = width(text) > total ? crop(text, total) : text;
      const gap = total - width(content);
      out += `${styled(
        " ".repeat(Math.floor(gap / 2)) + content + " ".repeat(Math.ceil(gap / 2)),
        3,
        policy.ansi,
      )}\n`;
    }
  out += border("┏", "┳", "┓", "━");
  const renderRow = (row: readonly string[], header: boolean, rowIndex = -1): string => {
    const cells = columns.map((column, i) =>
      cellLines(row[i] ?? "", sizes[i] ?? 1, column.justify ?? "left"),
    );
    const height = Math.max(...cells.map((cell) => cell.length));
    let result = "";
    for (let line = 0; line < height; line++) {
      result += header ? "┃" : "│";
      result += cells
        .map((cell, i) => {
          const index = header ? line - (height - cell.length) : line;
          const content = cell[index];
          if (content === undefined)
            return styled(" ".repeat(widths[i] ?? 0), 1, header && policy.ansi);
          return header
            ? styled(" ", 1, policy.ansi) +
                styled(content, 1, policy.ansi) +
                styled(" ", 1, policy.ansi)
            : ` ${styleBody(content, rowIndex, i)} `;
        })
        .join(header ? "┃" : "│");
      result += `${header ? "┃" : "│"}\n`;
    }
    return result;
  };
  out += renderRow(
    columns.map((column) => column.header),
    true,
  );
  out += border("┡", "╇", "┩", "━");
  for (const [index, row] of rows.entries()) out += renderRow(row, false, index);
  out += border("└", "┴", "┘", "─");
  return out;
}
