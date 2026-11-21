import { describe, expect, it } from "vitest";
import { listFiles, readRepoFile, TEST_FILE } from "../repo.ts";
import {
  findLiveDataViolations,
  LIVE_DATA_ALLOWED,
  LIVE_DATA_SCOPE,
  unallowedHits,
} from "./liveData.ts";

const kinds = (src: string) => findLiveDataViolations(src).map((h) => `${h.line}:${h.kind}`);

describe("findLiveDataViolations (detector)", () => {
  it("flags polling, refetch, revalidation, reloads and focus re-reads", () => {
    const src = [
      "const timer = setInterval(() => setPoll((n) => n + 1), 1_000);",
      "const status = useQuery(updateStatus, { poll });",
      "const info = useQuery(hostSettingsInfo, { poll: hostPoll, privacy });",
      "const { data, refetch } = useSomething();",
      "mutate(key, { revalidate: true });",
      "location.reload();",
      "void writes.reload();",
      'window.addEventListener("focus", reread);',
      "document.addEventListener('visibilitychange', reread);",
      "window.onfocus = reread;",
      "const tick = usePoll(60_000);",
    ].join("\n");
    expect(kinds(src)).toEqual([
      "1:setInterval",
      "2:poll arg",
      "3:poll arg",
      "4:refetch",
      "5:revalidate",
      "6:reload",
      "7:reload",
      "8:focus / visibility listener",
      "9:focus / visibility listener",
      "10:focus / visibility listener",
      "11:poll hook",
    ]);
  });

  it("flags a manual refresh button handler (owner decision: views update by themselves)", () => {
    const src = [
      "<Button onPress={() => void state.refreshConnectors()}>{C.refresh}</Button>",
      "<Button onPress={state.onAuditRefreshed}>{C.refresh}</Button>",
      "<button onClick={rescan} />",
      "onAuditRefreshed: () => setSince(now()),",
      "<Button onPress={p.onReload}>{p.reload}</Button>",
      "<Button onPress={() => void state.sync()}>{T.sync}</Button>",
    ].join("\n");
    expect(kinds(src)).toEqual([
      "1:refresh handler",
      "2:refresh handler",
      "3:refresh handler",
      "4:refresh handler",
    ]);
  });

  it("flags a setTimeout loop that re-arms itself, directly or through a helper", () => {
    const direct = [
      "useEffect(() => {",
      "  let timer: ReturnType<typeof setTimeout>;",
      "  const tick = () => {",
      "    void reread();",
      "    timer = setTimeout(tick, 5_000);",
      "  };",
      "  tick();",
      "}, []);",
    ].join("\n");
    expect(kinds(direct)).toEqual(["5:self-rescheduling setTimeout"]);
    const indirect = [
      "function schedule() {",
      "  window.setTimeout(() => refresh(), 1_000);",
      "}",
      "function refresh() {",
      "  setValue(read());",
      "  schedule();",
      "}",
    ].join("\n");
    expect(kinds(indirect)).toEqual(["2:self-rescheduling setTimeout"]);
    const named = "setTimeout(function loop() { load(); setTimeout(loop, 500); }, 500);";
    expect(kinds(named)).toEqual(["1:self-rescheduling setTimeout"]);
  });

  it("flags a counter or a clock in a query's args, under any name and through a local", () => {
    const counter = [
      "const [nonce, setNonce] = useState(0);",
      "const bump = () => setNonce((n) => n + 1);",
      "const rows = useQuery(rowsQuery, { vault, nonce });",
    ].join("\n");
    expect(kinds(counter)).toEqual(["3:cache-busting query arg"]);
    const reducer = [
      "const [tick, force] = useReducer((x: number) => x + 1, 0);",
      "const args = useMemo(() => ({ vault, tick }), [vault, tick]);",
      "const rows = useQuery(rowsQuery, args);",
    ].join("\n");
    expect(kinds(reducer)).toEqual(["3:cache-busting query arg"]);
    const stamped = [
      "const [at, setAt] = useState(0);",
      "const again = () => setAt(Date.now());",
      "const rows = useQuery(rowsQuery, {",
      "  at,",
      "});",
    ].join("\n");
    expect(kinds(stamped)).toEqual(["3:cache-busting query arg"]);
    expect(kinds("const rows = useQuery(rowsQuery, { at: Date.now() });")).toEqual([
      "1:cache-busting query arg",
    ]);
    expect(kinds("const rows = useQuery(rowsQuery, { salt: Math.random() });")).toEqual([
      "1:cache-busting query arg",
    ]);
  });

  it("flags a focus / visibility listener whose event name sits in a variable", () => {
    const src = [
      'const EVENT = "visibilitychange";',
      "document.addEventListener(EVENT, reread);",
      'window.addEventListener(hidden ? "focus" : "blur", reread);',
    ].join("\n");
    expect(kinds(src)).toEqual(["2:focus / visibility listener", "3:focus / visibility listener"]);
  });

  it("accepts live queries, non-data timers and comments", () => {
    const src = [
      "const status = useQuery(updateStatus);",
      "const info = useQuery(hostSettingsInfo, { privacy: incognito });",
      "const t = setTimeout(() => setFlash(null), 2660);",
      "const pollingInterval = props.interval; // a name, not a key",
      "// setInterval(poll) and location.reload() in a comment are fine",
      'input.addEventListener("blur", onBlur);',
      "const answer = { kind: 'poll-free' };",
      "const [page, setPage] = useState(0);",
      "const next = () => setPage(page + 1);",
      "const [query, setQuery] = useState('');",
      "const rows = useQuery(searchQuery, { query, privacy });",
      "const debounce = () => { timer.current = setTimeout(() => run(query), 250); };",
      "const run = (q: string) => setQuery(q);",
      "const expire = () => setExpired(true);",
      "const arm = () => { const id = setTimeout(expire, 1_000); return () => clearTimeout(id); };",
    ].join("\n");
    expect(findLiveDataViolations(src)).toEqual([]);
  });

  it("an allow-list entry covers one hit on its line only", () => {
    const path = "apps/desktop/renderer/routes.tsx";
    const entry = LIVE_DATA_ALLOWED.find((e) => e.path === path);
    if (entry === undefined) throw new Error("routes.tsx entry missing");
    const allowed = `      <button type="button" ${entry.line}>`;
    const hits = findLiveDataViolations(
      [allowed, "const again = () => location.reload();", allowed].join("\n"),
    );
    expect(hits.map((h) => h.kind)).toEqual(["reload", "reload", "reload"]);
    expect(unallowedHits(path, hits).map((h) => h.line)).toEqual([2, 3]);
    expect(unallowedHits("apps/desktop/renderer/other.tsx", hits)).toHaveLength(3);
  });
});

describe("guard: the renderer reads live queries, never polls or refetches (S55l)", () => {
  const files = listFiles(["apps/desktop/renderer"], /\.tsx?$/).filter(
    (f) => LIVE_DATA_SCOPE.test(f) && !TEST_FILE.test(f),
  );

  it("covers the whole renderer but its entry point", () => {
    expect(files).toContain("apps/desktop/renderer/routes.tsx");
    expect(files).toContain("apps/desktop/renderer/screens/settings/useSettingsScreen.ts");
    expect(files).toContain("apps/desktop/renderer/shell/useCalendarDay.ts");
    expect(files).toContain("apps/desktop/renderer/App.tsx");
    expect(files).not.toContain("apps/desktop/renderer/main.tsx");
  });

  it(`no polling / refetch / reload / focus re-read / timer loop / busted args (${files.length} files)`, () => {
    const hits = files.flatMap((f) =>
      unallowedHits(f, findLiveDataViolations(readRepoFile(f))).map(
        (h) => `${f}:${h.line} ${h.kind}: ${h.text}`,
      ),
    );
    expect(hits, "serve the value as a live query the host re-pushes").toEqual([]);
  });

  it("every allow-list entry still matches its hit (no stale exceptions)", () => {
    const stale = LIVE_DATA_ALLOWED.filter(
      (entry) =>
        !files.includes(entry.path) ||
        !findLiveDataViolations(readRepoFile(entry.path)).some(
          (h) => h.kind === entry.kind && h.source.includes(entry.line),
        ),
    ).map((entry) => `${entry.path} ${entry.kind} ${entry.line}`);
    expect(stale).toEqual([]);
  });
});
