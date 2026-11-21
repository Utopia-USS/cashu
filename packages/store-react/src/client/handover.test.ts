// The port client when the host hands over to a new process (sync switched on, a profile's data removed
// from sync, a device admitted): just before it goes, the host fails the window's live queries, then the
// link drops and a new host announces itself. Within the reconnect window (`errorRetryMs`) such an error
// never reaches the readers and the shown value stays; an error that outlives the window does. The
// channel is a hand-driven relay stand-in, so every frame and its order is explicit. Synthetic data.
import { STORE_PROTOCOL_VERSION, type StoreToHost } from "@cashu/host-protocol/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { profileName } from "../testing/fixtures.js";
import { createPortClient } from "./port.js";
import type { Channel, SnapshotState, Target } from "./types.js";

const VAULT = "a".repeat(32);
const TARGET: Target = { kind: "vault", vault: VAULT };
const RETRY = [500, 1_000, 2_000, 4_000] as const;
const WINDOW = RETRY.reduce((sum, ms) => sum + ms, 0);
const GONE = { name: "NativeSessionUnavailableError", message: "the session is closing" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(errorRetryMs: readonly number[] = RETRY) {
  const sent: StoreToHost[] = [];
  let receive: (message: unknown) => void = () => {};
  /** Answers every `sub` the client sends (the host side); default: nothing. */
  let answer: (sub: Extract<StoreToHost, { t: "sub" }>) => void = () => {};
  const channel: Channel = {
    post(message) {
      const m = message as StoreToHost;
      sent.push(m);
      if (m.t === "sub") answer(m);
    },
    listen(listener) {
      receive = listener;
      return () => {};
    },
  };
  const ready = createPortClient(channel, { errorRetryMs, lingerMs: 0 });
  receive({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [VAULT] });
  const client = await ready;
  const entry = client.entry(TARGET, profileName, undefined);
  /** Every state the readers were told about, in order. */
  const seen: SnapshotState<string | null>["status"][] = [];
  const off = entry.subscribe(() => seen.push(entry.getSnapshot().status));
  const subs = () => sent.filter((m): m is Extract<StoreToHost, { t: "sub" }> => m.t === "sub");
  const first = subs()[0];
  if (first === undefined) throw new Error("missing subscription");
  return {
    client,
    entry,
    seen,
    subs,
    first,
    receive: (message: unknown) => receive(message),
    answerWith(next: typeof answer) {
      answer = next;
    },
    close() {
      off();
      client.dispose();
    },
  };
}

it("a handover keeps the shown value and brings the new host's value, never an error", async () => {
  const t = await setup();
  try {
    t.receive({ t: "value", sid: t.first.sid, generation: 0, value: "Ala" });
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ala" });

    // The old host fails the live query on its way out, then the link drops.
    t.receive({ t: "error", sid: t.first.sid, generation: 0, error: GONE });
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ala" });
    vi.advanceTimersByTime(RETRY[0]);
    t.receive({ t: "error", sid: t.first.sid, generation: 0, error: GONE });
    t.receive({ t: "link", state: "connecting" });
    t.receive({ t: "link", state: "starting" });
    // The host restart takes longer than the whole window: still the last value, no error.
    vi.advanceTimersByTime(WINDOW * 2);
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ala" });

    // The new host: the query is asked again and its value replaces the stale one.
    t.receive({ t: "link", state: "connected" });
    t.receive({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [VAULT] });
    const resumed = t.subs().at(-1);
    expect(resumed).toMatchObject({ sid: t.first.sid, generation: 1, resume: true });
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ala" });
    t.receive({ t: "value", sid: t.first.sid, generation: 1, value: "Ola" });
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ola" });
    vi.advanceTimersByTime(WINDOW * 2);

    // The readers only ever saw values: never a loading state, never an error.
    expect(t.seen).toEqual(["value", "value"]);
  } finally {
    t.close();
  }
});

it("an error that a re-ask answers with a value (a busy host) never reaches the readers", async () => {
  const t = await setup();
  try {
    t.receive({ t: "value", sid: t.first.sid, generation: 0, value: "Ala" });
    t.receive({ t: "error", sid: t.first.sid, generation: 0, error: GONE });
    t.answerWith((sub) =>
      queueMicrotask(() =>
        t.receive({ t: "value", sid: sub.sid, generation: sub.generation, value: "Ala" }),
      ),
    );
    vi.advanceTimersByTime(RETRY[0]);
    await Promise.resolve();
    expect(t.subs()).toHaveLength(2);
    vi.advanceTimersByTime(WINDOW * 2);
    expect(t.subs()).toHaveLength(2);
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ala" });
    expect(t.seen).toEqual(["value"]);
  } finally {
    t.close();
  }
});

it("an error that outlives the reconnect window while connected reaches the readers", async () => {
  const t = await setup();
  try {
    t.receive({ t: "value", sid: t.first.sid, generation: 0, value: "Ala" });
    // A real failure: every re-ask fails the same way and the link stays up.
    t.answerWith((sub) =>
      t.receive({ t: "error", sid: sub.sid, generation: sub.generation, error: GONE }),
    );
    t.receive({ t: "error", sid: t.first.sid, generation: 0, error: GONE });
    vi.advanceTimersByTime(WINDOW - 1);
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ala" });
    // Asked again after 0.5, 1.5 and 3.5 s; the last 4 s only wait for that answer.
    expect(t.subs()).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(t.entry.getSnapshot()).toMatchObject({
      status: "error",
      error: { name: GONE.name, message: GONE.message },
    });
    expect(t.seen).toEqual(["value", "error"]);

    // The failure screen's retry asks the failed query again from the start.
    t.answerWith((sub) =>
      t.receive({ t: "value", sid: sub.sid, generation: sub.generation, value: "Ala" }),
    );
    t.client.retryFailed();
    expect(t.subs()).toHaveLength(5);
    expect(t.entry.getSnapshot()).toEqual({ status: "value", value: "Ala" });
  } finally {
    t.close();
  }
});

it("without a reconnect window an error is final at once (the phone and the default)", async () => {
  const t = await setup([]);
  try {
    t.receive({ t: "value", sid: t.first.sid, generation: 0, value: "Ala" });
    t.receive({ t: "error", sid: t.first.sid, generation: 0, error: GONE });
    expect(t.entry.getSnapshot()).toMatchObject({ status: "error" });
    expect(t.subs()).toHaveLength(1);
  } finally {
    t.close();
  }
});
