import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CRASH_LOOP_WINDOW_MS, recordStart } from "./crashLoop.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const runDir = () => {
  const d = mkdtempSync(join(tmpdir(), "cashu-crash-"));
  dirs.push(d);
  return d;
};

describe("crash-loop record", () => {
  it("enters safe mode on the start after three unclean starts within the window", () => {
    const dir = runDir();
    const t = 1_000_000_000;
    expect(recordStart(dir, t).safeMode).toBe(false);
    expect(recordStart(dir, t + 1).safeMode).toBe(false);
    expect(recordStart(dir, t + 2).safeMode).toBe(false);
    const fourth = recordStart(dir, t + 3);
    expect(fourth).toMatchObject({ safeMode: true, recentCrashes: 3 });
  });

  it("forgets starts outside the window and after a clean exit", () => {
    const dir = runDir();
    const t = 1_000_000_000;
    for (let i = 0; i < 3; i++) recordStart(dir, t + i);
    expect(recordStart(dir, t + CRASH_LOOP_WINDOW_MS + 10).safeMode).toBe(false);
    const record = recordStart(dir, t + CRASH_LOOP_WINDOW_MS + 20);
    record.clean();
    expect(JSON.parse(readFileSync(join(dir, "starts.json"), "utf8")).unclean).toEqual([]);
    expect(recordStart(dir, t + CRASH_LOOP_WINDOW_MS + 30).recentCrashes).toBe(0);
  });
});
