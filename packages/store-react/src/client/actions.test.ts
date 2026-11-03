import {
  STORE_PROTOCOL_VERSION,
  type StoreToClient,
  type StoreToHost,
} from "@cashu/host-protocol/store";
import { expect, it } from "vitest";
import { createPortClient } from "./port.js";
import type { Channel } from "./types.js";

it("seeds actual privacy before first work, drops private delivery on toggle and never replays actions", async () => {
  const sent: StoreToHost[] = [];
  let receive: (message: unknown) => void = () => {};
  let privacy = false;
  let changed = () => {};
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
  receive({
    t: "ready",
    protocol: STORE_PROTOCOL_VERSION,
    vaults: [vault],
  } satisfies StoreToClient);
  const client = await ready;
  expect(sent[0]).toEqual({ t: "uiPolicy", generation: 0, privacy: false });
  const action = { id: "investments.strategies.reload" };
  const pending = client.invoke({ kind: "vault", vault }, action, {});
  privacy = true;
  changed();
  expect(await pending).toEqual({ status: "outcome_unknown", reason: "interrupted" });
  const request = sent.find((message) => message.t === "action");
  if (request?.t !== "action") throw new Error("missing action request");
  receive({
    t: "actionResult",
    rid: request.rid,
    result: { status: "completed", value: "private result" },
  });
  receive({ t: "link", state: "connecting" });
  expect(await client.invoke({ kind: "vault", vault }, action, {})).toEqual({
    status: "not_started",
    reason: "disconnected",
  });
  receive({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [vault] });
  expect(sent.filter((message) => message.t === "action")).toHaveLength(1);
  expect(sent.at(-1)).toEqual({ t: "uiPolicy", generation: 1, privacy: true });
  client.dispose();
});
