import { describe, expect, it } from "vitest";
import { listFiles, readRepoFile, TEST_FILE } from "../repo.ts";
import { findLiveDataViolations, LIVE_DATA_ALLOWED, LIVE_DATA_SCOPE } from "./liveData.ts";

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
    expect(findLiveDataViolations(src).map((h) => `${h.line}:${h.kind}`)).toEqual([
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

  it("accepts live queries, non-data timers and comments", () => {
    const src = [
      "const status = useQuery(updateStatus);",
      "const info = useQuery(hostSettingsInfo, { privacy: incognito });",
      "const t = setTimeout(() => setFlash(null), 2660);",
      "const pollingInterval = props.interval; // a name, not a key",
      "// setInterval(poll) and location.reload() in a comment are fine",
      'input.addEventListener("blur", onBlur);',
      "const answer = { kind: 'poll-free' };",
    ].join("\n");
    expect(findLiveDataViolations(src)).toEqual([]);
  });
});

describe("guard: renderer data hooks read live queries, never poll or refetch (S55l)", () => {
  const files = listFiles(["apps/desktop/renderer"], /\.tsx?$/).filter(
    (f) => LIVE_DATA_SCOPE.test(f) && !TEST_FILE.test(f),
  );
  const allowed = (path: string, kind: string) =>
    LIVE_DATA_ALLOWED.some((entry) => entry.path === path && entry.kind === kind);

  it("covers the renderer's hooks, routes and screens", () => {
    expect(files).toContain("apps/desktop/renderer/routes.tsx");
    expect(files).toContain("apps/desktop/renderer/screens/settings/useSettingsScreen.ts");
    expect(files).toContain("apps/desktop/renderer/shell/useCalendarDay.ts");
    expect(files).not.toContain("apps/desktop/renderer/main.tsx");
  });

  it(`no polling / refetch / reload / focus re-read in renderer data hooks (${files.length} files)`, () => {
    const hits = files.flatMap((f) =>
      findLiveDataViolations(readRepoFile(f))
        .filter((h) => !allowed(f, h.kind))
        .map((h) => `${f}:${h.line} ${h.kind}: ${h.text}`),
    );
    expect(hits, "serve the value as a live query the host re-pushes").toEqual([]);
  });

  it("every allow-list entry still matches a hit (no stale exceptions)", () => {
    const stale = LIVE_DATA_ALLOWED.filter(
      (entry) =>
        !files.includes(entry.path) ||
        !findLiveDataViolations(readRepoFile(entry.path)).some((h) => h.kind === entry.kind),
    ).map((entry) => `${entry.path} ${entry.kind}`);
    expect(stale).toEqual([]);
  });
});
