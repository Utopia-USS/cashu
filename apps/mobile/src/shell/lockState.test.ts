// The app lock's reducer: boot, the background timeout, inactive spells (the Face ID prompt, the app
// switcher), the setting, prompts and the automatic prompt once per return.
import type { AppStateStatus } from "react-native";
import {
  dueForPrompt,
  initialLock,
  LOCK_AFTER_MS,
  type LockEvent,
  type LockState,
  reduceLock,
} from "./lockState";

const T0 = 1_000_000;

function run(state: LockState, ...events: LockEvent[]): LockState {
  return events.reduce(reduceLock, state);
}

/** An AppState change at wall time `at`; the monotonic clock agrees with the wall clock unless given. */
function move(from: AppStateStatus, to: AppStateStatus, at: number, mono = at): LockEvent {
  return { kind: "appState", from, to, at, mono };
}

const booted = (enabled: boolean) => reduceLock(initialLock("active"), { kind: "boot", enabled });

describe("boot", () => {
  it("starts locked with the lock on", () => {
    const state = booted(true);
    expect(state).toMatchObject({ enabled: true, locked: true, failure: null });
    expect(dueForPrompt(state)).toBe(true);
  });

  it("starts unlocked with the lock off", () => {
    const state = booted(false);
    expect(state).toMatchObject({ enabled: false, locked: false });
    expect(dueForPrompt(state)).toBe(false);
  });

  it("does not prompt before the app is active", () => {
    const state = reduceLock(initialLock("background"), { kind: "boot", enabled: true });
    expect(state.locked).toBe(true);
    expect(dueForPrompt(state)).toBe(false);
    expect(dueForPrompt(run(state, move("background", "active", T0)))).toBe(true);
  });
});

describe("background", () => {
  const unlocked = run(booted(true), { kind: "prompt" }, { kind: "unlocked" });

  it("records when the app went to the background", () => {
    expect(run(unlocked, move("active", "background", T0)).backgroundedAt).toBe(T0);
  });

  it("counts the first arrival in the background on iOS's active -> inactive -> background", () => {
    const state = run(
      unlocked,
      move("active", "inactive", T0 - 500),
      move("inactive", "background", T0),
    );
    expect(state.backgroundedAt).toBe(T0);
  });

  it("locks on return after LOCK_AFTER_MS or more", () => {
    const state = run(
      unlocked,
      move("active", "background", T0),
      move("background", "active", T0 + LOCK_AFTER_MS),
    );
    expect(state).toMatchObject({ locked: true, backgroundedAt: null, autoPrompted: false });
    expect(dueForPrompt(state)).toBe(true);
  });

  it("locks on return through inactive too", () => {
    const state = run(
      unlocked,
      move("active", "background", T0),
      move("background", "inactive", T0 + LOCK_AFTER_MS),
      move("inactive", "active", T0 + LOCK_AFTER_MS + 100),
    );
    expect(state.locked).toBe(true);
  });

  it("stays unlocked on a return within LOCK_AFTER_MS", () => {
    const state = run(
      unlocked,
      move("active", "background", T0),
      move("background", "active", T0 + LOCK_AFTER_MS - 1),
    );
    expect(state).toMatchObject({ locked: false, backgroundedAt: null });
  });

  describe("clock changes while away", () => {
    it("locks when the clock was set back (the return is earlier than the departure)", () => {
      const state = run(
        unlocked,
        move("active", "background", T0),
        move("background", "active", T0 - 60 * 60 * 1000),
      );
      expect(state).toMatchObject({ locked: true, backgroundedAt: null, autoPrompted: false });
      expect(dueForPrompt(state)).toBe(true);
    });

    it("locks when the clock was set back by a single millisecond", () => {
      const state = run(
        unlocked,
        move("active", "background", T0),
        move("background", "active", T0 - 1),
      );
      expect(state.locked).toBe(true);
    });

    it("locks when the clock was set forward past LOCK_AFTER_MS", () => {
      const state = run(
        unlocked,
        move("active", "background", T0),
        move("background", "active", T0 + 24 * 60 * 60 * 1000),
      );
      expect(state.locked).toBe(true);
    });

    it("stays unlocked on an equal clock (an instant round trip)", () => {
      const state = run(
        unlocked,
        move("active", "background", T0),
        move("background", "active", T0),
      );
      expect(state).toMatchObject({ locked: false, backgroundedAt: null });
    });

    // The monotonic clock (M0 on departure) cannot be set back; the absence is the larger reading.
    const M0 = 5_000;
    const HOURS_2 = 2 * 60 * 60 * 1000;

    it("locks when the clock was set back by LESS than the time away (wall reads +10 s, away 2 h)", () => {
      const state = run(
        unlocked,
        move("active", "background", T0, M0),
        // Away 2 h; the wall clock was set back by 2 h minus 10 s, so it reads only 10 s later.
        move("background", "active", T0 + 10_000, M0 + HOURS_2),
      );
      expect(state).toMatchObject({ locked: true, backgroundedAt: null, backgroundedMono: null });
      expect(dueForPrompt(state)).toBe(true);
    });

    it("locks when the monotonic clock alone passes LOCK_AFTER_MS", () => {
      const state = run(
        unlocked,
        move("active", "background", T0, M0),
        move("background", "active", T0 + 1, M0 + LOCK_AFTER_MS),
      );
      expect(state.locked).toBe(true);
    });

    it("stays unlocked when both clocks say a short spell", () => {
      const state = run(
        unlocked,
        move("active", "background", T0, M0),
        move("background", "active", T0 + LOCK_AFTER_MS - 1, M0 + LOCK_AFTER_MS - 1),
      );
      expect(state).toMatchObject({ locked: false, backgroundedAt: null, backgroundedMono: null });
    });

    it("measures from the first arrival in the background on both clocks", () => {
      const state = run(
        unlocked,
        move("active", "inactive", T0, M0),
        move("inactive", "background", T0 + 5, M0 + 5),
        move("background", "background", T0 + 10, M0 + 10),
      );
      expect(state).toMatchObject({ backgroundedAt: T0 + 5, backgroundedMono: M0 + 5 });
      const back = run(state, move("background", "active", T0 + 20, M0 + 5 + LOCK_AFTER_MS));
      expect(back.locked).toBe(true);
    });

    it("never locks with the lock off, even with the clock set back", () => {
      const state = run(
        booted(false),
        move("active", "background", T0),
        move("background", "active", T0 - 60 * 60 * 1000),
      );
      expect(state.locked).toBe(false);
    });
  });

  it("never locks with the lock off", () => {
    const state = run(
      booted(false),
      move("active", "background", T0),
      move("background", "active", T0 + 10 * LOCK_AFTER_MS),
    );
    expect(state.locked).toBe(false);
  });

  it("prompts again on each return while still locked", () => {
    const failed = run(booted(true), { kind: "prompt" }, { kind: "promptEnded", result: "failed" });
    expect(dueForPrompt(failed)).toBe(false);
    const back = run(
      failed,
      move("active", "background", T0),
      move("background", "active", T0 + 1),
    );
    expect(back).toMatchObject({ locked: true, autoPrompted: false, failure: null });
    expect(dueForPrompt(back)).toBe(true);
  });
});

describe("inactive", () => {
  const unlocked = run(booted(true), { kind: "prompt" }, { kind: "unlocked" });

  it("never locks, however long (Control Center, a call banner, the app switcher left open)", () => {
    const state = run(
      unlocked,
      move("active", "inactive", T0),
      move("inactive", "active", T0 + 10 * LOCK_AFTER_MS),
    );
    expect(state.locked).toBe(false);
  });

  it("the Face ID prompt round trip stays unlocked (active -> inactive -> active within 2 s)", () => {
    const state = run(
      unlocked,
      { kind: "prompt" },
      move("active", "inactive", T0),
      move("inactive", "active", T0 + 2_000),
      { kind: "unlocked" },
    );
    expect(state).toMatchObject({ locked: false, prompting: false, backgroundedAt: null });
  });

  it("the unlock prompt's own inactive spell does not prompt again", () => {
    const state = run(
      booted(true),
      { kind: "prompt" },
      move("active", "inactive", T0),
      move("inactive", "active", T0 + 1_500),
      { kind: "promptEnded", result: "cancelled" },
    );
    expect(state).toMatchObject({ locked: true, prompting: false, failure: null });
    expect(dueForPrompt(state)).toBe(false);
  });
});

describe("prompts", () => {
  it("unlocked clears the lock and any failure", () => {
    const state = run(
      booted(true),
      { kind: "prompt" },
      { kind: "promptEnded", result: "failed" },
      { kind: "prompt" },
      { kind: "unlocked" },
    );
    expect(state).toMatchObject({ locked: false, prompting: false, failure: null });
  });

  it("a prompt in flight blocks the automatic one", () => {
    const state = run(booted(true), { kind: "prompt" });
    expect(state.prompting).toBe(true);
    expect(dueForPrompt(state)).toBe(false);
  });

  it.each([
    ["failed", "failed"],
    ["unavailable", "unavailable"],
    ["cancelled", null],
  ] as const)("a %s prompt leaves the failure %s", (result, failure) => {
    const state = run(booted(true), { kind: "prompt" }, { kind: "promptEnded", result });
    expect(state).toMatchObject({ locked: true, prompting: false, failure });
  });
});

describe("setting", () => {
  it("off unlocks and disables", () => {
    const state = run(booted(true), { kind: "setting", enabled: false });
    expect(state).toMatchObject({ enabled: false, locked: false });
  });

  it("on enables without locking now", () => {
    const state = run(booted(false), { kind: "setting", enabled: true });
    expect(state).toMatchObject({ enabled: true, locked: false });
    const later = run(
      state,
      move("active", "background", T0),
      move("background", "active", T0 + LOCK_AFTER_MS),
    );
    expect(later.locked).toBe(true);
  });
});
