// Guard: live data in the desktop renderer (milestone S55l). Every screen reads through
// `@cashu/store-react` `useQuery` live queries; a write anywhere (host, worker, CLI, MCP, another
// window, sync) reaches an open screen by a host push. So the renderer never polls, refetches,
// revalidates, reloads, re-reads on focus / visibility, re-arms a timer loop or busts a query's args
// with a counter or a clock. Timers that are not data (toast / undo / flash timers, debounce, scroll,
// expiry of a pending flow) stay allowed: a one-shot `setTimeout` is not a pattern here. Nor does a screen
// offer a manual Refresh / Check again button (owner decision 2026-11-06): a handler wired to a `refresh*`,
// `rescan*` or `recheck*` function, or an `on*Refresh*` prop, is flagged. The few
// listed exceptions below (a display clock, the crash retry, an owner import) carry their reason and
// the exact line they allow.
import { stripComments } from "../repo.ts";

export interface LiveDataHit {
  line: number;
  kind: string;
  /** The matched fragment. */
  text: string;
  /** The whole (trimmed) source line, what an allow-list snippet is matched against. */
  source: string;
}

/** Every renderer source file but the entry point (tests and stories are dropped by the caller). */
export const LIVE_DATA_SCOPE = /^apps\/desktop\/renderer\/(?!main\.tsx$).+\.tsx?$/;

const match =
  (re: RegExp) =>
  (line: string): string | null =>
    re.exec(line)?.[0].trim() ?? null;

/** Events that mean "the window came back": a re-read trigger, never a data source. */
const RETURN_EVENTS = /^["'`](?:focus|focusin|visibilitychange|pageshow)["'`]$/;

const LINE_RULES: ReadonlyArray<{ kind: string; find: (line: string) => string | null }> = [
  { kind: "setInterval", find: match(/\bsetInterval\s*\(/) },
  { kind: "refetch", find: match(/\brefetch\w*/i) },
  { kind: "revalidate", find: match(/\brevalidat\w*/i) },
  { kind: "reload", find: match(/(?:\blocation)?\.reload\s*\(/) },
  // A `poll` key in a query args object (`{ poll: n }`, shorthand `{ poll }`) or a poll hook.
  { kind: "poll arg", find: match(/[{,]\s*poll\s*(?::|(?=[,}]))/) },
  { kind: "poll hook", find: match(/\buse[A-Z]?\w*Poll\w*\s*\(/) },
  {
    kind: "focus / visibility listener",
    find: match(
      /\baddEventListener\s*\(\s*["'`](?:focus|focusin|visibilitychange|pageshow)["'`]|\bon(?:focus|visibilitychange|pageshow)\s*=/,
    ),
  },
  // A UI handler that only re-reads: `onPress={() => state.refresh()}`, `onClick={refreshX}`, `onXRefreshed: ...`.
  {
    kind: "refresh handler",
    find: match(
      /\bon[A-Z]\w*=\{[^}]*(?:\b(?:refresh|rescan|recheck)|Refresh|Rescan|Recheck)\w*|\bon\w*(?:Refresh|Rescan|Recheck)\w*\s*[=:(]/,
    ),
  },
];

/** The index just past the bracket closing the one at `open` (`(`, `{`, `[`); the end when unbalanced. */
function closing(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i] ?? "";
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (pairs[c] !== undefined) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return src.length;
}

/** The top-level arguments of the call whose `(` is at `open`. */
function callArgs(src: string, open: number): { args: string[]; end: number } {
  const end = closing(src, open);
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let i = open + 1; i < end - 1; i += 1) {
    const c = src[i] ?? "";
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  args.push(src.slice(start, end - 1));
  return { args: args.map((a) => a.trim()), end };
}

interface FunctionSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Named functions of a file: `function f(`, `const f = (...) =>` / `async`, `const f = function`,
 * `const f = useCallback((...) => ...)`. The span is the body (a block, or an expression body up to
 * the end of its statement).
 */
function functionSpans(src: string): FunctionSpan[] {
  const spans: FunctionSpan[] = [];
  const declared =
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:useCallback\s*\(\s*)?(?:async\s+)?(?:function\b[^(]*\(|\(|[A-Za-z_$][\w$]*\s*=>)/g;
  for (const m of src.matchAll(declared)) {
    const name = m[1] ?? m[2];
    if (name === undefined) continue;
    const from = (m.index ?? 0) + m[0].length - 1;
    // The parameter list (when the match ended on its `(`), then `=>` or the body's `{`.
    let i = src[from] === "(" ? closing(src, from) : from + 1;
    const rest = /^\s*(?::[^={]+)?(=>)?\s*/.exec(src.slice(i));
    i += rest?.[0].length ?? 0;
    if (src[i] === "{") spans.push({ name, start: i, end: closing(src, i) });
    else if (rest?.[1] !== undefined || /=>\s*$/.test(m[0])) {
      const stop = /[;\n]/.exec(src.slice(i));
      const end = stop === null ? src.length : i + stop.index;
      // An expression body may span lines inside brackets: extend over a bracket opened on it.
      const open = /[({[]/.exec(src.slice(i, end));
      spans.push({ name, start: i, end: open ? Math.max(end, closing(src, i + open.index)) : end });
    }
  }
  return spans;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

/** Names called (`name(`) or handed over as a bare identifier in `text`. */
function referenced(text: string, names: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) if (names.has(m[0])) out.add(m[0]);
  return out;
}

/** A `setTimeout` whose callback reaches, through local functions, a function that schedules it. */
function selfReschedulingTimers(src: string): Array<{ index: number; text: string }> {
  const spans = functionSpans(src);
  const names = new Set(spans.map((s) => s.name));
  const calls = new Map<string, Set<string>>();
  for (const s of spans) {
    const own = calls.get(s.name) ?? new Set<string>();
    for (const n of referenced(src.slice(s.start, s.end), names)) own.add(n);
    calls.set(s.name, own);
  }
  const hits: Array<{ index: number; text: string }> = [];
  for (const m of src.matchAll(/\b(?:window\.)?setTimeout\s*\(/g)) {
    const index = m.index ?? 0;
    const callback = callArgs(src, index + m[0].length - 1).args[0] ?? "";
    const enclosing = new Set(
      spans.filter((s) => s.start < index && index < s.end).map((s) => s.name),
    );
    if (enclosing.size === 0) continue;
    const seen = new Set<string>();
    const queue = [...referenced(callback, names)];
    let loops = false;
    while (queue.length > 0 && !loops) {
      const name = queue.shift() ?? "";
      if (seen.has(name)) continue;
      seen.add(name);
      if (enclosing.has(name)) loops = true;
      else queue.push(...(calls.get(name) ?? []));
    }
    if (loops) hits.push({ index, text: `setTimeout(${callback.split("\n")[0]}` });
  }
  return hits;
}

/** A value that differs on every evaluation: a clock or a random number. */
const FRESH = /\b(?:Date\.now|performance\.now|Math\.random|crypto\.randomUUID)\s*\(/;

/**
 * State that only exists to change: a `useState` whose setter is called with an increment
 * (`set((n) => n + 1)`, `set(n + 1)`) or a fresh value (`set(Date.now())`), or a `useReducer`
 * counter (`useReducer((n) => n + 1, 0)`).
 */
function counterStates(src: string): Set<string> {
  const counters = new Set<string>();
  for (const m of src.matchAll(
    /\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState\b/g,
  )) {
    const [, value, setter] = m;
    if (value === undefined || setter === undefined) continue;
    for (const call of src.matchAll(new RegExp(`\\b${setter.replace(/\$/g, "\\$")}\\s*\\(`, "g"))) {
      const arg = callArgs(src, (call.index ?? 0) + call[0].length - 1).args[0] ?? "";
      const updater = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([\s\S]*)$/.exec(arg);
      const body = updater ? updater[2] : arg;
      const base = updater ? updater[1] : value;
      if (
        FRESH.test(arg) ||
        new RegExp(
          `^\\(?\\s*${(base ?? "").replace(/\$/g, "\\$")}\\s*(?:\\+\\s*\\d|-\\s*\\d|\\+\\+)`,
        ).test(body ?? "")
      )
        counters.add(value);
    }
  }
  for (const m of src.matchAll(
    /\[\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*useReducer\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)[^=]*=>\s*\(?\s*([A-Za-z_$][\w$]*)\s*\+/g,
  )) {
    if (m[1] !== undefined && m[2] === m[3]) counters.add(m[1]);
  }
  return counters;
}

/** The initializer of `const name = ...` (one level of indirection for query args). */
function initializer(src: string, name: string): string | null {
  const m = new RegExp(
    `\\b(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=;\n]+)?=\\s*`,
  ).exec(src);
  if (m === null) return null;
  const from = (m.index ?? 0) + m[0].length;
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i] ?? "";
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if ((c === ";" || c === "\n") && depth <= 0) return src.slice(from, i);
  }
  return src.slice(from);
}

/** `useQuery(query, args)` whose args (or a local they name) carry a counter state or a fresh value. */
function cacheBustingArgs(src: string): Array<{ index: number; text: string }> {
  const counters = counterStates(src);
  const hits: Array<{ index: number; text: string }> = [];
  for (const m of src.matchAll(/\buseQuery\s*\(/g)) {
    const index = m.index ?? 0;
    const args = callArgs(src, index + m[0].length - 1)
      .args.slice(1)
      .join(", ");
    const words = [...args.matchAll(/[A-Za-z_$][\w$]*/g)].map((w) => w[0]);
    const indirect = words.map((w) => (counters.has(w) ? null : initializer(src, w)));
    const bust =
      (FRESH.exec(args)?.[0] ?? words.find((w) => counters.has(w))) ||
      indirect
        .map((init) =>
          init === null
            ? undefined
            : (FRESH.exec(init)?.[0] ??
              [...init.matchAll(/[A-Za-z_$][\w$]*/g)]
                .map((w) => w[0])
                .find((w) => counters.has(w))),
        )
        .find((found) => found !== undefined);
    if (bust) hits.push({ index, text: `useQuery(... ${bust} ...)` });
  }
  return hits;
}

/** `addEventListener(name, ...)` where `name` is a local bound to a focus / visibility event. */
function returnEventVariables(src: string): Array<{ index: number; text: string }> {
  const bound = new Set<string>();
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(["'`][\w-]+["'`])/g,
  ))
    if (m[1] !== undefined && RETURN_EVENTS.test(m[2] ?? "")) bound.add(m[1]);
  const hits: Array<{ index: number; text: string }> = [];
  for (const m of src.matchAll(/\baddEventListener\s*\(/g)) {
    const index = m.index ?? 0;
    const event = callArgs(src, index + m[0].length - 1).args[0] ?? "";
    if (RETURN_EVENTS.test(event)) continue; // the line rule reports it
    const literal = [...event.matchAll(/["'`][\w-]+["'`]/g)].some((l) => RETURN_EVENTS.test(l[0]));
    const named = [...event.matchAll(/[A-Za-z_$][\w$]*/g)].some((w) => bound.has(w[0]));
    if (literal || named) hits.push({ index, text: `addEventListener(${event}` });
  }
  return hits;
}

/** Live-data violations in one renderer source file (comments ignored). */
export function findLiveDataViolations(source: string): LiveDataHit[] {
  const src = stripComments(source);
  const lines = src.split("\n");
  const at = (line: number) => (lines[line - 1] ?? "").trim();
  const hits: LiveDataHit[] = [];
  lines.forEach((line, i) => {
    for (const { kind, find } of LINE_RULES) {
      const text = find(line);
      if (text) hits.push({ line: i + 1, kind, text, source: line.trim() });
    }
  });
  const spanned: ReadonlyArray<[string, Array<{ index: number; text: string }>]> = [
    ["self-rescheduling setTimeout", selfReschedulingTimers(src)],
    ["cache-busting query arg", cacheBustingArgs(src)],
    ["focus / visibility listener", returnEventVariables(src)],
  ];
  for (const [kind, found] of spanned)
    for (const { index, text } of found) {
      const line = lineOf(src, index);
      hits.push({ line, kind, text, source: at(line) });
    }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Reviewed exceptions: not data refreshes. Each entry allows exactly one hit of its kind in its file
 * whose source line contains `line`; a second hit (even an identical line) fails, and so does a stale
 * entry (nothing matches it any more).
 */
export const LIVE_DATA_ALLOWED: ReadonlyArray<{
  readonly path: string;
  readonly kind: string;
  readonly line: string;
  readonly reason: string;
}> = [
  {
    path: "apps/desktop/renderer/shell/useCalendarDay.ts",
    kind: "focus / visibility listener",
    line: 'window.addEventListener("focus", refresh);',
    reason: "display clock: re-derives today's date after the machine slept, reads no data",
  },
  {
    path: "apps/desktop/renderer/shell/useCalendarDay.ts",
    kind: "self-rescheduling setTimeout",
    line: "timer = setTimeout(refresh, next.getTime() - now.getTime() + 1);",
    reason: "display clock: re-arms at the next local midnight to roll today's date, reads no data",
  },
  {
    path: "apps/desktop/renderer/routes.tsx",
    kind: "reload",
    line: "onClick={() => location.reload()}",
    reason: "the crash screen's retry button restarts the page after a render error",
  },
  {
    path: "apps/desktop/renderer/screens/strategies/useStrategySettings.ts",
    kind: "reload",
    line: "void writes.reload().then(",
    reason:
      "owner command 'Wczytaj ponownie' imports strategy.yaml from disk into the store (a write); the screen sees it by push",
  },
];

/** The hits of one file the allow-list does not cover (each entry consumes at most one hit). */
export function unallowedHits(path: string, hits: readonly LiveDataHit[]): LiveDataHit[] {
  const left = LIVE_DATA_ALLOWED.filter((entry) => entry.path === path);
  return hits.filter((hit) => {
    const i = left.findIndex((entry) => entry.kind === hit.kind && hit.source.includes(entry.line));
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}
