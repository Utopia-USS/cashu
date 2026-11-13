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

function move(from: AppStateStatus, to: AppStateStatus, at: number): LockEvent {
  return { kind: "appState", from, to, at };
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
