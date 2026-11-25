import { STORE_PROTOCOL_VERSION, type StoreToHost } from "@cashu/host-protocol/store";
import { expect, it } from "vitest";
import { profileName } from "../testing/fixtures.js";
import { createPortClient } from "./port.js";
import type { Channel } from "./types.js";

it("clears old snapshots, ignores stale replies and resumes existing subscriptions", async () => {
  const sent: StoreToHost[] = [];
  let receive: (message: unknown) => void = () => {};
  let changed = () => {};
  let privacy = false;
  const channel: Channel = {
    post(message) {
      sent.push(message as StoreToHost);
    },
    listen(listener) {
      receive = listener;
      return () => {};
    },
  };
  const ready = createPortClient(channel, {
    uiPrivacy: {
      getSnapshot: () => privacy,
      subscribe(listener) {
        changed = listener;
        return () => {};
      },
    },
  });
  const vault = "a".repeat(32);
  receive({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [vault] });
  const client = await ready;
  try {
    const entry = client.entry({ kind: "vault", vault }, profileName, undefined);
    const first = sent.find((message) => message.t === "sub");
    if (first?.t !== "sub") throw new Error("missing first subscription");
    expect(first).toMatchObject({ generation: 0, resume: false });
    receive({ t: "value", sid: first.sid, generation: 0, value: "private" });
    expect(entry.getSnapshot()).toEqual({ status: "value", value: "private" });
    const second = client.entry({ kind: "vault", vault }, profileName, { second: true } as never);
    const secondSub = sent.at(-1);
    if (secondSub?.t !== "sub") throw new Error("missing second subscription");
    receive({ t: "value", sid: secondSub.sid, generation: 0, value: "other private" });
    const seenDuringReset: string[] = [];
    const off = entry.subscribe(() => seenDuringReset.push(second.getSnapshot().status));

    privacy = true;
    changed();
    expect(entry.getSnapshot()).toEqual({ status: "pending" });
    expect(second.getSnapshot()).toEqual({ status: "pending" });
    expect(seenDuringReset).toEqual(["pending"]);
    expect(sent.at(-3)).toEqual({ t: "uiPolicy", generation: 1, privacy: true });
    expect(sent.at(-2)).toMatchObject({ t: "sub", sid: first.sid, generation: 1, resume: true });
    off();
    receive({ t: "value", sid: first.sid, generation: 0, value: "late private" });
    receive({
      t: "error",
      sid: first.sid,
      generation: 0,
      error: { name: "PrivacyRestricted", message: "late" },
    });
    expect(entry.getSnapshot()).toEqual({ status: "pending" });

    privacy = false;
    changed();
    expect(sent.at(-2)).toMatchObject({ t: "sub", sid: first.sid, generation: 2, resume: true });
    receive({ t: "value", sid: first.sid, generation: 1, value: "stale" });
    expect(entry.getSnapshot()).toEqual({ status: "pending" });
    receive({ t: "value", sid: first.sid, generation: 2, value: "fresh" });
    expect(entry.getSnapshot()).toEqual({ status: "value", value: "fresh" });

    privacy = true;
    changed();
    const fresh = client.entry({ kind: "vault", vault }, profileName, { other: true } as never);
    const newSub = sent.at(-1);
    expect(newSub).toMatchObject({ t: "sub", generation: 3, resume: false });
    if (newSub?.t !== "sub") throw new Error("missing new subscription");
    receive({
      t: "error",
      sid: newSub.sid,
      generation: 3,
      error: { name: "PrivacyRestricted", message: "refused" },
    });
    expect(fresh.getSnapshot()).toMatchObject({ status: "error" });

    receive({ t: "link", state: "connecting" });
    receive({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [vault] });
    expect(sent).toContainEqual({ t: "uiPolicy", generation: 4, privacy: true });
    expect(sent.at(-1)).toMatchObject({ t: "sub", sid: newSub.sid, generation: 4, resume: true });
    expect(fresh.getSnapshot()).toEqual({ status: "pending" });
    receive({ t: "value", sid: first.sid, generation: 3, value: "pre-reconnect private" });
    receive({ t: "value", sid: newSub.sid, generation: 3, value: "pre-reconnect new" });
    expect(entry.getSnapshot()).toEqual({ status: "pending" });
    expect(fresh.getSnapshot()).toEqual({ status: "pending" });
    privacy = false;
    changed();
    receive({ t: "value", sid: first.sid, generation: 5, value: "after reconnect" });
    expect(entry.getSnapshot()).toEqual({ status: "value", value: "after reconnect" });
  } finally {
    client.dispose();
  }
});

it("keeps new subscriptions and actions created by a reset listener in the new generation", async () => {
  const sent: StoreToHost[] = [];
  let receive: (message: unknown) => void = () => {};
  let changed = () => {};
  let privacy = false;
  const ready = createPortClient(
    {
      post(message) {
        sent.push(message as StoreToHost);
      },
      listen(listener) {
        receive = listener;
        return () => {};
      },
    },
    {
      uiPrivacy: {
        getSnapshot: () => privacy,
        subscribe(listener) {
          changed = listener;
          return () => {};
        },
      },
    },
  );
  const vault = "a".repeat(32);
  receive({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [vault] });
  const client = await ready;
  try {
    const target = { kind: "vault" as const, vault };
    const old = client.entry(target, profileName, undefined);
    const action = { id: "test.action" };
    const interrupted = client.invoke(target, action, {});
    let newAction: ReturnType<typeof client.invoke> | undefined;
    const off = old.subscribe(() => {
      if (newAction !== undefined) return;
      client.entry(target, profileName, { new: true } as never);
      newAction = client.invoke(target, action, {});
    });
    privacy = true;
    changed();
    expect(await interrupted).toEqual({ status: "outcome_unknown", reason: "interrupted" });
    const created = sent.find(
      (message) => message.t === "sub" && message.generation === 1 && !message.resume,
    );
    expect(created).toBeDefined();
    const actions = sent.filter((message) => message.t === "action");
    expect(actions).toHaveLength(2);
    const secondAction = actions[1];
    if (secondAction?.t !== "action") throw new Error("missing current action");
    receive({
      t: "actionResult",
      rid: secondAction.rid,
      result: { status: "completed", value: null },
    });
    expect(await newAction).toEqual({ status: "completed", value: null });
    off();
  } finally {
    client.dispose();
  }
});
