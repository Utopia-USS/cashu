// The pairing flow's reducer: the camera-denied path, the steps in order, cancel only before storing,
// failures before and after the commit point.
import {
  initialPairState,
  isCancellable,
  type PairEvent,
  type PairState,
  pairReducer,
  scanAgainHelps,
} from "./pairState";

const run = (events: readonly PairEvent[], from: PairState = initialPairState("iPhone")) =>
  events.reduce(pairReducer, from);

describe("pairReducer", () => {
  it("makes paste the way in when the camera is denied, and keeps it there", () => {
    const denied = run([{ type: "camera", access: "denied" }]);
    expect(denied).toMatchObject({ kind: "scan", input: "paste", camera: "denied" });
    expect(pairReducer(denied, { type: "input", input: "camera" })).toBe(denied);
    expect(run([{ type: "camera", access: "granted" }])).toMatchObject({ input: "camera" });
  });

  it("walks scan -> connecting -> code -> receiving -> storing -> role -> firstSync -> closed", () => {
    const steps: PairEvent[] = [
      { type: "name", name: "Telefon Ali" },
      { type: "connecting" },
      { type: "sas", sas: "418207", expiresAt: 1000 },
      { type: "part" },
      { type: "part" },
      { type: "storing" },
      { type: "stored", vault: "v1" },
      { type: "role", role: "partner" },
    ];
    const seen = steps.map((_, i) => run(steps.slice(0, i + 1)).kind);
    expect(seen).toEqual([
      "scan",
      "connecting",
      "code",
      "receiving",
      "receiving",
      "storing",
      "role",
      "role",
    ]);
    const role = run(steps);
    expect(role).toEqual({ kind: "role", vault: "v1", role: "partner" });
    expect(run([{ type: "connecting" }, { type: "sas", sas: "1", expiresAt: 5 }])).toMatchObject({
      kind: "code",
      name: "iPhone",
    });
    expect(run(steps.slice(0, 5))).toMatchObject({ kind: "receiving", parts: 2 });
    const synced = run([{ type: "roleSaved" }, { type: "finish" }], role);
    expect(synced).toEqual({ kind: "closed" });
  });

  it("cancels every step before storing and none after it", () => {
    const before = [
      initialPairState("x"),
      run([{ type: "discardAsked", profile: "Ala", qr: "q" }]),
      run([{ type: "connecting" }]),
      run([{ type: "connecting" }, { type: "sas", sas: "1", expiresAt: 1 }]),
      run([{ type: "connecting" }, { type: "sas", sas: "1", expiresAt: 1 }, { type: "part" }]),
      run([{ type: "failed", reason: "offline" }]),
    ];
    for (const state of before) {
      expect(isCancellable(state)).toBe(true);
      expect(pairReducer(state, { type: "cancel" })).toEqual({ kind: "closed" });
    }
    const after: PairState[] = [
      { kind: "storing", name: "x" },
      { kind: "role", vault: "v", role: "owner" },
      { kind: "firstSync", vault: "v" },
    ];
    for (const state of after) {
      expect(isCancellable(state)).toBe(false);
      expect(pairReducer(state, { type: "cancel" })).toBe(state);
    }
  });

  it("fails before the commit point and while storing, never once the vault is on the phone", () => {
    expect(run([{ type: "connecting" }, { type: "failed", reason: "taken" }])).toEqual({
      kind: "failed",
      name: "iPhone",
      reason: "taken",
    });
    expect(
      pairReducer({ kind: "storing", name: "n" }, { type: "failed", reason: "failed" }),
    ).toEqual({ kind: "failed", name: "n", reason: "failed" });
    const role: PairState = { kind: "role", vault: "v", role: "owner" };
    expect(pairReducer(role, { type: "failed", reason: "offline" })).toBe(role);
  });

  it("starts over on Scan again with the name it had", () => {
    const failed = run([
      { type: "name", name: "Mój iPhone" },
      { type: "connecting" },
      { type: "failed", reason: "expired" },
    ]);
    expect(pairReducer(failed, { type: "scanAgain", camera: "granted" })).toEqual({
      kind: "scan",
      input: "camera",
      camera: "granted",
      name: "Mój iPhone",
      notACode: false,
    });
    // A camera denied before: the new scan opens on the paste path, not an empty camera frame.
    expect(pairReducer(failed, { type: "scanAgain", camera: "denied" })).toMatchObject({
      kind: "scan",
      input: "paste",
      camera: "denied",
    });
  });

  it("clears 'not a cashU code' once the pasted text changes", () => {
    const wrong = run([{ type: "input", input: "paste" }, { type: "notACode" }]);
    expect(wrong).toMatchObject({ notACode: true });
    expect(pairReducer(wrong, { type: "edited" })).toMatchObject({ kind: "scan", notACode: false });
    const clean = run([{ type: "input", input: "paste" }]);
    expect(pairReducer(clean, { type: "edited" })).toBe(clean);
  });

  it("offers a new scan only for failures a new code can fix", () => {
    const helps = (
      [
        "expired",
        "taken",
        "other_project",
        "offline",
        "no_sync",
        "refused",
        "unpushed",
        "failed",
      ] as const
    ).filter(scanAgainHelps);
    expect(helps).toEqual(["expired", "taken", "offline", "refused", "unpushed", "failed"]);
  });

  it("edits the name only while scanning: the hello signs it", () => {
    const code = run([{ type: "connecting" }, { type: "sas", sas: "1", expiresAt: 1 }]);
    expect(pairReducer(code, { type: "name", name: "other" })).toBe(code);
  });
});
