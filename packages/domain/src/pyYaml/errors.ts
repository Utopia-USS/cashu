/**
 * PyYAML's `error.py` (`Mark`, `MarkedYAMLError`) and the `ReaderError` of `reader.py`: the error the
 * stages throw internally (`YamlFailure`, caught only by `composeYaml`) and the Python `str(error)`
 * text, snippet lines included.
 */

/** A position in the input: 0-based line and column, index in code points (PyYAML's `Mark`). */
export interface YamlMark {
  readonly line: number;
  readonly column: number;
  readonly index: number;
}

/** `MarkedYAMLError` (scanner / parser / composer) or `ReaderError`, with Python's `str(error)`. */
export type YamlError =
  | {
      readonly kind: "marked";
      readonly context: string | null;
      readonly contextMark: YamlMark | null;
      readonly problem: string | null;
      readonly problemMark: YamlMark | null;
      readonly note: string | null;
      readonly text: string;
    }
  | { readonly kind: "reader"; readonly text: string };

/** What a stage raised, before the text is rendered against the input buffer. */
export type YamlFailureDetail =
  | {
      readonly kind: "marked";
      readonly context: string | null;
      readonly contextMark: YamlMark | null;
      readonly problem: string | null;
      readonly problemMark: YamlMark | null;
      readonly note: string | null;
    }
  /** `character` = the code point refused, `position` = its code point index. */
  | { readonly kind: "reader"; readonly position: number; readonly character: number };

/** The internal exception of the port (PyYAML's `YAMLError` subclasses); never escapes `composeYaml`. */
export class YamlFailure extends Error {
  readonly detail: YamlFailureDetail;

  constructor(detail: YamlFailureDetail) {
    super("yaml");
    this.detail = detail;
  }
}

/** `MarkedYAMLError(context, context_mark, problem, problem_mark, note)`. */
export function markedError(
  context: string | null,
  contextMark: YamlMark | null,
  problem: string | null,
  problemMark: YamlMark | null,
  note: string | null = null,
): YamlFailure {
  return new YamlFailure({ kind: "marked", context, contextMark, problem, problemMark, note });
}

/** The name `Reader` gives a `str` input. */
const NAME = "<unicode string>";
const SNIPPET_STOP = "\0\r\n\x85\u2028\u2029";

/** `Mark.get_snippet(indent=4, max_length=75)`; `buffer` = the code points plus the trailing NUL. */
function snippet(buffer: readonly string[], pointer: number): string {
  const indent = 4;
  const half = 75 / 2 - 1;
  let head = "";
  let start = pointer;
  while (start > 0 && !SNIPPET_STOP.includes(buffer[start - 1] ?? "\0")) {
    start -= 1;
    if (pointer - start > half) {
      head = " ... ";
      start += 5;
      break;
    }
  }
  let tail = "";
  let end = pointer;
  while (end < buffer.length && !SNIPPET_STOP.includes(buffer[end] ?? "\0")) {
    end += 1;
    if (end - pointer > half) {
      tail = " ... ";
      end -= 5;
      break;
    }
  }
  const text = buffer.slice(start, end).join("");
  return `${" ".repeat(indent)}${head}${text}${tail}\n${" ".repeat(indent + pointer - start + head.length)}^`;
}

/** `str(Mark)` (a `str` input always has a buffer, so the snippet is always there). */
function markText(mark: YamlMark, buffer: readonly string[]): string {
  return `  in "${NAME}", line ${mark.line + 1}, column ${mark.column + 1}:\n${snippet(buffer, mark.index)}`;
}

/** `MarkedYAMLError.__str__` / `ReaderError.__str__`. */
export function renderError(detail: YamlFailureDetail, buffer: readonly string[]): YamlError {
  if (detail.kind === "reader") {
    const code = detail.character.toString(16).padStart(4, "0");
    return {
      kind: "reader",
      text: `unacceptable character #x${code}: special characters are not allowed\n  in "${NAME}", position ${detail.position}`,
    };
  }
  const { context, contextMark, problem, problemMark, note } = detail;
  const lines: string[] = [];
  if (context !== null) lines.push(context);
  if (
    contextMark !== null &&
    (problem === null ||
      problemMark === null ||
      contextMark.line !== problemMark.line ||
      contextMark.column !== problemMark.column)
  ) {
    lines.push(markText(contextMark, buffer));
  }
  if (problem !== null) lines.push(problem);
  if (problemMark !== null) lines.push(markText(problemMark, buffer));
  if (note !== null) lines.push(note);
  return {
    kind: "marked",
    context,
    contextMark,
    problem,
    problemMark,
    note,
    text: lines.join("\n"),
  };
}
