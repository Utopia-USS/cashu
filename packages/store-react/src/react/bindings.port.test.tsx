// The bindings over the port adapter, as in the desktop renderer: a stand-in for the local host's
// store channel v2 serves real in-memory stores behind a stand-in for Electron main's relay
// (testing/host.ts). Synthetic data only.
import { createProfile, renameProfile } from "@cashu/store";
import { currentVault, setCurrentVault } from "@cashu/store/device";
import type { Query, QueryArgs } from "@cashu/store/query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteStoreError } from "../client/errors.js";
import { createPortClient } from "../client/port.js";
import {
  accountRows,
  Bomb,
  ErrorBoundary,
  explode,
  Fallback,
  Fragile,
  fallbackMounts,
  fragileName,
  profileName,
} from "../testing/fixtures.js";
import { TestHost, testRelay } from "../testing/host.js";
import { memoryStores, VAULT_A } from "../testing/memory.js";
import { ProfileProvider } from "./ProfileProvider.js";
import { StoreProvider } from "./StoreProvider.js";
import { useCommand } from "./useCommand.js";
import { useQuery } from "./useQuery.js";

const closers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
});

const QUERIES: Query<QueryArgs, unknown>[] = [currentVault, profileName, accountRows, fragileName];
const COMMANDS = [createProfile, renameProfile, setCurrentVault, explode];

async function setup(options: { onError?: (e: unknown) => void } = {}) {
  const stores = memoryStores();
  const host = new TestHost({
    stores,
    queries: QUERIES,
    commands: COMMANDS,
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const pair = testRelay(host);
  const client = await createPortClient(pair.client, { lingerMs: 0 });
  fallbackMounts.count = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>
      <ErrorBoundary>
        <Suspense fallback={<Fallback />}>
          <ProfileProvider fallback={<p>no profile</p>}>{children}</ProfileProvider>
        </Suspense>
      </ErrorBoundary>
    </StoreProvider>
  );
  closers.push(() => {
    client.dispose();
    pair.close();
    stores.close();
  });
  return { stores, client, pair, wrapper, fallbacks: () => fallbackMounts.count };
}

/** Render a tree that suspends: in the act environment the retry must be awaited (React 19). */
async function renderAsync(ui: ReactNode, options: Parameters<typeof render>[1]) {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(ui, options);
  });
  if (view === undefined) throw new Error("not rendered");
  return view;
}

function Name({ id }: { id: string }) {
  const name = useQuery(profileName);
  const { run, isPending } = useCommand(renameProfile);
  return (
    <button type="button" data-testid={id} onClick={() => void run({ name: "Ela" })}>
      {`${name}${isPending ? " (saving)" : ""}`}
    </button>
  );
}

describe("useQuery (port adapter)", () => {
  it("suspends on the first read of a key only; later changes are pushed", async () => {
    const { wrapper, fallbacks } = await setup();
    const view = await renderAsync(<Name id="a" />, { wrapper });
    expect((await screen.findByTestId("a")).textContent).toBe("Ala");
    const afterFirstRead = fallbacks();
    expect(afterFirstRead).toBe(1);

    act(() => screen.getByTestId("a").click());
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("Ela"));

    // A second reader of the same key mounts from the cache.
    view.rerender(
      <>
        <Name id="a" />
        <Name id="b" />
      </>,
    );
    expect(screen.getByTestId("b").textContent).toBe("Ela");
    expect(fallbacks()).toBe(afterFirstRead);
  });

  it("subscribes once per key and unsubscribes after the last reader left", async () => {
    const { wrapper, pair, stores } = await setup();
    const store = stores.vaults.get(VAULT_A)?.store;
    if (store === undefined) throw new Error("no vault");
    let active = 0;
    const subscribe = store.subscribe.bind(store);
    vi.spyOn(store, "subscribe").mockImplementation((tables, listener) => {
      active += 1;
      const off = subscribe(tables, listener);
      return () => {
        active -= 1;
        off();
      };
    });
    const view = await renderAsync(
      <>
        <Name id="a" />
        <Name id="b" />
      </>,
      { wrapper },
    );
    await screen.findByTestId("b");
    const subs = pair.sent.filter(
      (m) => (m as { t: string; query?: string }).query === profileName.id,
    );
    expect(subs).toHaveLength(1);
    expect(active).toBe(1);
    view.unmount();
    await waitFor(() => expect(active).toBe(0));
    expect(pair.sent.filter((m) => (m as { t: string }).t === "unsub").length).toBeGreaterThan(0);
  });

  it("throws a failing query to the error boundary", async () => {
    const reported: unknown[] = [];
    const { wrapper } = await setup({ onError: (e) => reported.push(e) });
    await renderAsync(<Fragile />, { wrapper, onCaughtError: () => {} });
    const button = await screen.findByRole("button", { name: "Ala" });
    act(() => button.click());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "boundary: cannot decode the profile",
    );
    expect(reported).toHaveLength(1);
  });
});

describe("useCommand (port adapter)", () => {
  it("returns the result union, with isPending over the round trip", async () => {
    const { client } = await setup();
    const target = { kind: "vault", vault: VAULT_A } as const;
    expect(await client.run(target, createProfile, { slug: "x", name: "X" })).toEqual({
      ok: false,
      reason: "exists",
    });
    expect(await client.run(target, renameProfile, { name: "Ela" })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("throws an unexpected failure to the error boundary", async () => {
    const { wrapper } = await setup();
    await renderAsync(<Bomb />, { wrapper, onCaughtError: () => {} });
    const button = await screen.findByRole("button", { name: "go" });
    act(() => button.click());
    expect((await screen.findByRole("alert")).textContent).toBe("boundary: command bug");
  });

  it("refuses a command the store process did not register", async () => {
    const { client } = await setup();
    const unknown = { ...renameProfile, id: "test.notRegistered" };
    await expect(
      client.run({ kind: "vault", vault: VAULT_A }, unknown, { name: "x" }),
    ).rejects.toBeInstanceOf(RemoteStoreError);
  });
});
