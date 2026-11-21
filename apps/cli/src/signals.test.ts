// The shim around a foreground child: which terminal signals it leaves to the child, and how it ends
// when the child died of a signal (re-raised on POSIX, the shell's 128 + n exit code on Windows).
import { afterEach, describe, expect, it } from "vitest";
import { runForeground } from "./foreground.js";
import { sharedSignals, signalEnding, signalExitCode } from "./signals.js";
import { removeTempDirs, tempDir } from "./testing/dirs.js";

afterEach(removeTempDirs);

describe("shim signals", () => {
  it("leaves the terminal's group signals (POSIX) or console signals (Windows) to the child", () => {
    expect(sharedSignals("darwin")).toEqual(["SIGINT", "SIGQUIT", "SIGHUP"]);
    expect(sharedSignals("linux")).toEqual(["SIGINT", "SIGQUIT", "SIGHUP"]);
    expect(sharedSignals("win32")).toEqual(["SIGINT", "SIGBREAK", "SIGHUP"]);
  });

  it("re-raises a child's signal death on POSIX and exits with 128 + n on Windows", () => {
    expect(signalEnding("SIGTERM", "darwin")).toEqual({ kind: "raise", signal: "SIGTERM" });
    expect(signalEnding("SIGINT", "linux")).toEqual({ kind: "raise", signal: "SIGINT" });
    expect(signalEnding("SIGTERM", "win32")).toEqual({ kind: "exit", code: 143 });
    expect(signalEnding("SIGINT", "win32")).toEqual({ kind: "exit", code: 130 });
    expect(signalEnding("SIGKILL", "win32")).toEqual({ kind: "exit", code: 137 });
    expect(signalExitCode("SIGBREAK")).toBe(149);
    expect(signalExitCode("SIGHUP")).toBe(129);
  });

  it("ignores exactly the platform's shared signals while the child runs, then stops", async () => {
    const counts = (signals: readonly NodeJS.Signals[]) =>
      signals.map((signal) => process.listenerCount(signal));
    const watched: NodeJS.Signals[] = ["SIGINT", "SIGQUIT", "SIGBREAK", "SIGHUP", "SIGTERM"];
    const before = counts(watched);
    let during: number[] = [];
    const run = runForeground({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 300)"],
      env: { PATH: process.env.PATH },
      cwd: tempDir(),
      platform: "win32",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    during = counts(watched);
    expect(await run).toEqual({ kind: "exit", code: 0 });
    // SIGINT, SIGBREAK, SIGHUP ignored; SIGTERM forwarded; no SIGQUIT on Windows.
    expect(during.map((n, i) => n - (before[i] ?? 0))).toEqual([1, 0, 1, 1, 1]);
    expect(counts(watched)).toEqual(before);
  });
});
