// Page-side harness of the store port spec (92-store-port): bundled to one script and evaluated in
// the Electron window, it asks the preload for a store port, connects the real port client and reads
// a query / runs commands through it. The real renderer bootstrap does the same once a TS screen
// reads the store (TRANSITIONAL(S55a) in the preload).
import { createProfile, renameProfile } from "@cashu/store";
import { profile } from "@cashu/store/core";
import { currentVault } from "@cashu/store/device";
import type { Query } from "@cashu/store/query";
import {
  createPortClient,
  DEVICE_TARGET,
  messagePortChannel,
  type StoreClient,
  type Target,
} from "@cashu/store-react/client";

function requestStorePort(): Promise<MessagePort> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { cashu?: unknown } | null;
      const port = event.ports[0];
      if (event.source !== window || data?.cashu !== "store-port" || port === undefined) return;
      window.removeEventListener("message", onMessage);
      resolve(port);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ cashu: "store-port-request" }, window.location.origin);
  });
}

/** The first value of `query` whose snapshot satisfies `accept`, live through the port. */
function settledValue<R>(
  client: StoreClient,
  target: Target,
  query: Query<undefined, R>,
  accept: (value: R) => boolean = () => true,
): Promise<R> {
  const entry = client.entry(target, query, undefined);
  return new Promise((resolve, reject) => {
    const check = () => {
      const state = entry.getSnapshot();
      if (state.status === "error") reject(state.error);
      if (state.status === "value" && accept(state.value)) {
        unsubscribe();
        resolve(state.value);
      }
    };
    const unsubscribe = entry.subscribe(check);
    check();
  });
}

async function run() {
  const client = await createPortClient(messagePortChannel(await requestStorePort()));
  const vault = await settledValue(client, DEVICE_TARGET, currentVault);
  if (vault === null) throw new Error("no current vault");
  const target: Target = { kind: "vault", vault };
  const before = await settledValue(client, target, profile);
  const renamed = await client.run(target, renameProfile, { name: "Demo E2E" });
  const after = await settledValue(client, target, profile, (p) => p?.name === "Demo E2E");
  const refused = await client.run(target, createProfile, { slug: "again", name: "Again" });
  return {
    vaults: client.vaults.length,
    before: before?.name ?? null,
    renamed,
    after: after?.name ?? null,
    refused,
  };
}

(window as unknown as { cashuStoreHarness: typeof run }).cashuStoreHarness = run;
