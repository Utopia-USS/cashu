import { STORE_PROTOCOL_VERSION, type StoreToHost } from "@cashu/host-protocol/store";
import { renameProfile } from "@cashu/store";
import { currentVault } from "@cashu/store/device";
import { expect, it } from "vitest";
import { createPortClient } from "./port.js";
import type { Channel, CommandAttempt } from "./types.js";

const vault = "a".repeat(32);
const target = { kind: "vault" as const, vault };

async function setup() {
  const sent: StoreToHost[] = [];
  let receive: (message: unknown) => void = () => {};
  let changed = () => {};
  let privacy = false;
  let stopped = false;
  const channel: Channel = {
    post(message) {
      sent.push(message as StoreToHost);
    },
    listen(listener) {
      receive = listener;
      return () => {
        stopped = true;
      };
    },
  };
  const pending = createPortClient(channel, {
    mintKey: () => "01JBQX8Z5W3N4R6T7V8Y9A0BCD",
    uiPrivacy: {
      getSnapshot: () => privacy,
      subscribe(listener) {
        changed = listener;
        return () => {};
      },
    },
  });
  receive({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [vault] });
  const client = await pending;
  return {
    client,
    sent,
    receive,
    setPrivacy(value: boolean) {
      privacy = value;
      changed();
    },
    stopped: () => stopped,
  };
}

it("settles privacy-interrupted run and discards late private value before decoding", async () => {
  const { client, sent, receive, setPrivacy } = await setup();
  const pending = client.run(target, renameProfile, { name: "Synthetic" });
  const request = sent.find((message) => message.t === "run");
  if (request?.t !== "run") throw new Error("missing run");
  setPrivacy(true);
  const result = await pending;
  expect(result.kind).toBe("outcome_unknown");
  receive({
    t: "result",
    rid: request.rid,
    generation: request.generation,
    outcome: { kind: "completed", value: { "~cashu": "bad_private_tag" } },
  });
  if (result.kind !== "outcome_unknown") throw new Error("missing attempt");
  expect(await client.reconcile(result.attempt)).toEqual(result);
  expect(sent.filter((message) => message.t === "lookup")).toHaveLength(0);
  setPrivacy(false);
  const lookup = client.reconcile(result.attempt);
  const message = sent.find((item) => item.t === "lookup");
  if (message?.t !== "lookup") throw new Error("missing lookup");
  receive({
    t: "lookupResult",
    rid: message.rid,
    generation: message.generation,
    outcome: { kind: "not_started", reason: "attempt_missing" },
  });
  expect(await lookup).toEqual({ kind: "not_started", reason: "attempt_missing" });
  client.dispose();
});

it("settles run and lookup on dispose and removes the channel listener", async () => {
  const { client, sent, stopped } = await setup();
  const pending = client.run(target, renameProfile, { name: "Synthetic" });
  const request = sent.find((message) => message.t === "run");
  if (request?.t !== "run") throw new Error("missing run");
  const attempt: CommandAttempt = { key: request.key, target, command: request.command };
  const lookup = client.reconcile(attempt);
  client.dispose();
  expect((await pending).kind).toBe("outcome_unknown");
  expect((await lookup).kind).toBe("outcome_unknown");
  expect(stopped()).toBe(true);
  expect((await client.run(target, renameProfile, { name: "Again" })).kind).toBe("not_started");
});

it("invalidates an old vault result when the selected vault changes", async () => {
  const { client, sent, receive } = await setup();
  const device = { kind: "device" as const };
  client.entry(device, currentVault, undefined);
  const subscription = sent.find(
    (message) => message.t === "sub" && message.query === currentVault.id,
  );
  if (subscription?.t !== "sub") throw new Error("missing selection subscription");
  receive({ t: "value", sid: subscription.sid, generation: subscription.generation, value: vault });
  const pending = client.run(target, renameProfile, { name: "Synthetic" });
  const request = sent.find((message) => message.t === "run");
  if (request?.t !== "run") throw new Error("missing run");
  const pendingLookup = client.reconcile({ key: request.key, target, command: request.command });
  const lookupRequest = sent.find((message) => message.t === "lookup");
  if (lookupRequest?.t !== "lookup") throw new Error("missing lookup");
  receive({ t: "value", sid: subscription.sid, generation: subscription.generation, value: null });
  const result = await pending;
  expect((await pendingLookup).kind).toBe("outcome_unknown");
  if (result.kind !== "outcome_unknown") throw new Error("expected uncertain result");
  receive({
    t: "result",
    rid: request.rid,
    generation: request.generation,
    outcome: { kind: "completed", value: { "~cashu": "bad_private_tag" } },
  });
  receive({
    t: "lookupResult",
    rid: lookupRequest.rid,
    generation: lookupRequest.generation,
    outcome: { kind: "completed", value: { "~cashu": "bad_private_tag" } },
  });
  expect((await client.reconcile(result.attempt)).kind).toBe("outcome_unknown");
  expect(sent.filter((message) => message.t === "lookup")).toHaveLength(1);
  client.dispose();
});

it("keeps a pending result through a same-vault selection refresh", async () => {
  const { client, sent, receive } = await setup();
  client.entry({ kind: "device" }, currentVault, undefined);
  const subscription = sent.find(
    (message) => message.t === "sub" && message.query === currentVault.id,
  );
  if (subscription?.t !== "sub") throw new Error("missing selection subscription");
  receive({ t: "value", sid: subscription.sid, generation: subscription.generation, value: vault });
  const pending = client.run(target, renameProfile, { name: "Synthetic" });
  const request = sent.find((message) => message.t === "run");
  if (request?.t !== "run") throw new Error("missing run");
  receive({ t: "value", sid: subscription.sid, generation: subscription.generation, value: vault });
  receive({
    t: "result",
    rid: request.rid,
    generation: request.generation,
    outcome: { kind: "completed", value: null },
  });
  expect(await pending).toEqual({ kind: "completed", value: null });
  client.dispose();
});

it("waits for the selected vault snapshot before issuing a same-key lookup", async () => {
  const { client, sent, receive } = await setup();
  client.entry({ kind: "device" }, currentVault, undefined);
  const attempt: CommandAttempt = {
    key: "01JBQX8Z5W3N4R6T7V8Y9A0BCD",
    target,
    command: renameProfile.id,
  };
  expect((await client.reconcile(attempt)).kind).toBe("outcome_unknown");
  expect(sent.filter((message) => message.t === "lookup")).toHaveLength(0);
  const subscription = sent.find(
    (message) => message.t === "sub" && message.query === currentVault.id,
  );
  if (subscription?.t !== "sub") throw new Error("missing selection subscription");
  receive({ t: "value", sid: subscription.sid, generation: subscription.generation, value: vault });
  const pending = client.reconcile(attempt);
  const lookup = sent.find((message) => message.t === "lookup");
  if (lookup?.t !== "lookup") throw new Error("missing lookup");
  receive({
    t: "lookupResult",
    rid: lookup.rid,
    generation: lookup.generation,
    outcome: { kind: "not_started", reason: "attempt_missing" },
  });
  expect(await pending).toEqual({ kind: "not_started", reason: "attempt_missing" });
  client.dispose();
});
