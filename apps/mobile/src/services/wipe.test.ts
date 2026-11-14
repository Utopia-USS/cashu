// The wipe's order over fakes: the "Removing" state first, before-wipe tasks, Keychain items, one frame,
// then close before any file is deleted, one rebuild and one remount. A failed close, delete or rebuild
// remounts into the fatal state instead of the app and resolves `failed` (the fatal state is the report);
// a failure the app was rebuilt over is thrown last. The root's phases over the real epoch store:
// ready -> wiping -> ready (or failed).
import {
  bumpEpoch,
  getEpoch,
  getRootPhase,
  type RootPhase,
  showWiping,
  subscribeEpoch,
} from "./lifecycle";
import { beforeWipeTasks, onBeforeWipe, type WipeSteps, wipeDevice } from "./wipe";

type StepName = Exclude<keyof WipeSteps, "beforeWipe">;

function recorder(overrides: Partial<Record<StepName, () => void>> = {}) {
  const log: string[] = [];
  const step = (name: StepName) => (): void => {
    log.push(name);
    overrides[name]?.();
  };
  const steps: WipeSteps = {
    showWiping: step("showWiping"),
    beforeWipe: [
      async () => void log.push("cancelNotifications"),
      () => {
        log.push("failingTask");
        throw new Error("synthetic task failure");
      },
    ],
    deleteSecrets: async () => step("deleteSecrets")(),
    nextFrame: async () => step("nextFrame")(),
    close: step("close"),
    deleteFiles: step("deleteFiles"),
    reset: step("reset"),
    remount: (outcome) => {
      log.push(`remount:${outcome}`);
    },
  };
  return { log, steps };
}

describe("wipe", () => {
  it("shows Removing, then closes everything before deleting files, rebuilds and remounts once", async () => {
    const { log, steps } = recorder();
    expect(await wipeDevice(steps)).toBe("ready");
    expect(log).toEqual([
      "showWiping",
      "cancelNotifications",
      "failingTask",
      "deleteSecrets",
      "nextFrame",
      "close",
      "deleteFiles",
      "reset",
      "remount:ready",
    ]);
  });

  it("rebuilds and remounts the app after a Keychain failure, and reports it", async () => {
    const { log, steps } = recorder({
      deleteSecrets: () => {
        throw new Error("keychain");
      },
    });
    await expect(wipeDevice(steps)).rejects.toThrow("keychain");
    expect(log.slice(-5)).toEqual(["nextFrame", "close", "deleteFiles", "reset", "remount:ready"]);
  });

  it("deletes no file and rebuilds nothing when a close throws: the fatal state, no second report", async () => {
    const { log, steps } = recorder({
      close: () => {
        throw new Error("close");
      },
    });
    expect(await wipeDevice(steps)).toBe("failed");
    expect(log).not.toContain("deleteFiles");
    expect(log).not.toContain("reset");
    expect(log.at(-1)).toBe("remount:failed");
  });

  it("rebuilds nothing when a delete throws: the fatal state", async () => {
    const { log, steps } = recorder({
      deleteFiles: () => {
        throw new Error("files");
      },
    });
    expect(await wipeDevice(steps)).toBe("failed");
    expect(log).not.toContain("reset");
    expect(log.at(-1)).toBe("remount:failed");
  });

  it("still remounts, into the fatal state, when the rebuild throws", async () => {
    const { log, steps } = recorder({
      reset: () => {
        throw new Error("rebuild");
      },
    });
    expect(await wipeDevice(steps)).toBe("failed");
    expect(log.slice(-2)).toEqual(["reset", "remount:failed"]);
  });

  it("reports nothing more when an earlier failure is followed by the fatal state", async () => {
    const { log, steps } = recorder({
      deleteSecrets: () => {
        throw new Error("keychain");
      },
      reset: () => {
        throw new Error("rebuild");
      },
    });
    expect(await wipeDevice(steps)).toBe("failed");
    expect(log.at(-1)).toBe("remount:failed");
  });

  it("keeps before-wipe registrations outside the services until unregistered", () => {
    const task = () => {};
    const off = onBeforeWipe(task);
    expect(beforeWipeTasks()).toContain(task);
    off();
    expect(beforeWipeTasks()).not.toContain(task);
  });

  it("settles a first before-wipe task before any other starts, whatever the registration order", async () => {
    const log: string[] = [];
    let release: () => void = () => undefined;
    const offLater = onBeforeWipe(() => void log.push("forget"));
    const offFirst = onBeforeWipe(
      () =>
        new Promise<void>((resolve) => {
          log.push("quiesce:start");
          release = () => {
            log.push("quiesce:end");
            resolve();
          };
        }),
      { first: true },
    );
    const { steps } = recorder();
    const wipe = wipeDevice({ ...steps, beforeWipe: beforeWipeTasks() });
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual(["quiesce:start"]);
    release();
    expect(await wipe).toBe("ready");
    expect(log).toEqual(["quiesce:start", "quiesce:end", "forget"]);
    offFirst();
    offLater();
    expect(beforeWipeTasks()).toEqual([]);
  });

  it("goes on with the other tasks when a first task fails", async () => {
    const log: string[] = [];
    const { steps } = recorder();
    const first = Object.assign(
      () => {
        log.push("first");
        throw new Error("synthetic quiesce failure");
      },
      { first: true as const },
    );
    expect(await wipeDevice({ ...steps, beforeWipe: [() => void log.push("later"), first] })).toBe(
      "ready",
    );
    expect(log).toEqual(["first", "later"]);
  });
});

describe("root phases", () => {
  function watch() {
    const seen: { epoch: number; phase: RootPhase }[] = [];
    const off = subscribeEpoch(() => seen.push({ epoch: getEpoch(), phase: getRootPhase() }));
    return { seen, off };
  }
  const bound = (overrides: Partial<Record<StepName, () => void>> = {}): WipeSteps => ({
    ...recorder(overrides).steps,
    showWiping,
    remount: bumpEpoch,
  });

  it("goes ready -> wiping (same tree key) -> ready on a new key, the rebuild between", async () => {
    const before = getEpoch();
    expect(getRootPhase()).toBe("ready");
    const { seen, off } = watch();
    let phaseAtRebuild: RootPhase | null = null;
    await wipeDevice(
      bound({
        reset: () => {
          phaseAtRebuild = getRootPhase();
        },
      }),
    );
    off();
    expect(phaseAtRebuild).toBe("wiping");
    expect(seen).toEqual([
      { epoch: before, phase: "wiping" },
      { epoch: before + 1, phase: "ready" },
    ]);
  });

  it("ends in the fatal state when the rebuild throws, and a later wipe can recover", async () => {
    const { seen, off } = watch();
    const outcome = await wipeDevice(
      bound({
        reset: () => {
          throw new Error("rebuild");
        },
      }),
    );
    expect(outcome).toBe("failed");
    expect(seen.map((s) => s.phase)).toEqual(["wiping", "failed"]);
    await wipeDevice(bound());
    off();
    expect(getRootPhase()).toBe("ready");
  });
});
