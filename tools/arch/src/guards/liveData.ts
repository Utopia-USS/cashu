// Guard: live data in the desktop renderer (milestone S55l). Every screen reads through
// `@cashu/store-react` `useQuery` live queries; a write anywhere (host, worker, CLI, MCP, another
// window, sync) reaches an open screen by a host push. So renderer data hooks never poll, refetch,
// revalidate, reload, or re-read on focus / visibility. Timers that are not data (display clocks,
// toast / undo / flash timers, debounce, scroll, expiry of a pending flow) stay allowed: `setTimeout`
// is not a pattern here, and the few listed exceptions below carry their reason.
import { stripComments } from "../repo.ts";

export interface LiveDataHit {
  line: number;
  kind: string;
  text: string;
}

/** Renderer files that hold data hooks: `use*.ts(x)` anywhere, `routes.tsx`, everything in screens/. */
export const LIVE_DATA_SCOPE =
  /^apps\/desktop\/renderer\/(?:(?:.*\/)?use[A-Z][^/]*\.tsx?|routes\.tsx|screens\/.*\.tsx?)$/;

const match =
  (re: RegExp) =>
  (line: string): string | null =>
    re.exec(line)?.[0].trim() ?? null;

const RULES: ReadonlyArray<{ kind: string; find: (line: string) => string | null }> = [
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
];

/** Live-data violations in one renderer source file (comments ignored). */
export function findLiveDataViolations(source: string): LiveDataHit[] {
  const hits: LiveDataHit[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      for (const { kind, find } of RULES) {
        const text = find(line);
        if (text) hits.push({ line: i + 1, kind, text });
      }
    });
  return hits;
}

/** Reviewed exceptions: not data refreshes. A stale entry (nothing matches it any more) fails too. */
export const LIVE_DATA_ALLOWED: ReadonlyArray<{
  readonly path: string;
  readonly kind: string;
  readonly reason: string;
}> = [
  {
    path: "apps/desktop/renderer/shell/useCalendarDay.ts",
    kind: "focus / visibility listener",
    reason: "display clock: re-derives today's date after the machine slept, reads no data",
  },
  {
    path: "apps/desktop/renderer/routes.tsx",
    kind: "reload",
    reason: "the crash screen's retry button restarts the page after a render error",
  },
  {
    path: "apps/desktop/renderer/screens/strategies/useStrategySettings.ts",
    kind: "reload",
    reason:
      "owner command 'Wczytaj ponownie' imports strategy.yaml from disk into the store (a write); the screen sees it by push",
  },
];
