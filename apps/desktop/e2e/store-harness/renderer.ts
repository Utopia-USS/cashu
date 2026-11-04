// Page-side harness of the store specs (92-store-port, 93-host-restart): bundled as a test-only
// app-protocol script, it asks the preload for a store port (which main relays to the local
// host), connects the real port client and reads queries / runs commands through it. It also shows the
// connection status the way a TS screen will (the catalog texts, the stale-data note) and records every
// status and text, so the specs can check what the user saw. The production renderer owns its
// separate client only on its own page, never in this test page.
import { S } from "@cashu/i18n/core/hostConnection.strings";
import { createProfile, renameProfile } from "@cashu/store";
import { profile } from "@cashu/store/core";
import { currentVault } from "@cashu/store/device";
import type { Query } from "@cashu/store/query";
import {
  type ConnectionStatus,
  createPortClient,
  DEVICE_TARGET,
  isStale,
  messagePortChannel,
  type QueryCache,
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

const statuses: ConnectionStatus[] = [];
const shown: string[] = [];

function showStatus(status: ConnectionStatus): void {
  statuses.push(status);
  let element = document.getElementById("cashu-connection");
  if (element === null) {
    element = document.createElement("p");
    element.id = "cashu-connection";
    element.setAttribute("role", "status");
    document.body.append(element);
  }
  const text = isStale(status) ? `${S[status]} ${S.stale}` : S[status];
  element.textContent = text;
  shown.push(text);
}

let connecting: Promise<QueryCache> | null = null;
function client(): Promise<QueryCache> {
  connecting ??= requestStorePort().then((port) =>
    createPortClient(messagePortChannel(port), { onStatus: showStatus, recoveredMs: 1_000 }),
  );
  return connecting;
}

/** The first value of `query` whose snapshot satisfies `accept`, live through the port. */
function settledValue<R>(
  store: QueryCache,
  target: Target,
  query: Query<undefined, R>,
  accept: (value: R) => boolean = () => true,
): Promise<R> {
  const entry = store.entry(target, query, undefined);
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

async function vaultTarget(store: QueryCache): Promise<Target> {
  const vault = await settledValue(store, DEVICE_TARGET, currentVault);
  if (vault === null) throw new Error("no current vault");
  return { kind: "vault", vault };
}

/** 92: one read, a rename and a refusal through the port. */
let runStage = "idle";
async function run() {
  runStage = "port";
  const store = await client();
  runStage = "current-vault";
  const target = await vaultTarget(store);
  runStage = "profile";
  const before = await settledValue(store, target, profile);
  runStage = "rename";
  const renamed = await store.run(target, renameProfile, { name: "Demo E2E" });
  runStage = "renamed-profile";
  const after = await settledValue(store, target, profile, (p) => p?.name === "Demo E2E");
  runStage = "refusal";
  const refused = await store.run(target, createProfile, { slug: "again", name: "Again" });
  runStage = "complete";
  return {
    vaults: store.vaults.length,
    before: before?.name ?? null,
    renamed,
    after: after?.name ?? null,
    refused,
  };
}

/** 93: a live profile reader that stays subscribed, and commands whose answers arrive later. */
let target: Target | null = null;
let readName: () => string | null | undefined = () => undefined;
const results = new Map<number, unknown>();
let nextRun = 0;

const live = {
  async open(): Promise<string | null> {
    const store = await client();
    target = await vaultTarget(store);
    const entry = store.entry(target, profile, undefined);
    entry.subscribe(() => {});
    readName = () => {
      const state = entry.getSnapshot();
      return state.status === "value" ? (state.value?.name ?? null) : undefined;
    };
    return (await settledValue(store, target, profile))?.name ?? null;
  },
  /** The profile name the window shows now (the last snapshot, stale or not). */
  name: () => readName(),
  status: () => statuses.at(-1) ?? null,
  statuses: () => [...statuses],
  shown: () => [...shown],
  statusText: () => document.getElementById("cashu-connection")?.textContent ?? null,
  /** Starts a rename and returns at once; `result(id)` waits for its answer. */
  async rename(name: string): Promise<number> {
    const store = await client();
    if (target === null) throw new Error("open() first");
    const id = nextRun++;
    const done = store.run(target, renameProfile, { name });
    done.then(
      (r) => results.set(id, r),
      (e: unknown) => results.set(id, { thrown: e instanceof Error ? e.name : "error" }),
    );
    return id;
  },
  async result(id: number): Promise<unknown> {
    while (!results.has(id)) await new Promise((resolve) => setTimeout(resolve, 20));
    return results.get(id);
  },
  async reconcile(id: number): Promise<unknown> {
    const result = await this.result(id);
    if (
      result === null ||
      typeof result !== "object" ||
      !("kind" in result) ||
      result.kind !== "outcome_unknown" ||
      !("attempt" in result)
    )
      throw new Error("no unknown attempt");
    const store = await client();
    return store.reconcile(result.attempt as Parameters<QueryCache["reconcile"]>[0]);
  },
  async nameBecomes(name: string): Promise<void> {
    const store = await client();
    if (target === null) throw new Error("open() first");
    await settledValue(store, target, profile, (p) => p?.name === name);
  },
};

const page = window as unknown as {
  cashuStoreHarness: typeof run;
  cashuStoreStage: () => string;
  cashuStoreLive: typeof live;
};
page.cashuStoreHarness = run;
page.cashuStoreStage = () => runStage;
page.cashuStoreLive = live;
