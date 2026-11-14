// The bindings over the in-process (sync) adapter, as on the phone: real in-memory stores, hooks
// rendered with @testing-library/react. Synthetic data only.
import { createProfile, openAccount, renameAccount, renameProfile } from "@cashu/store";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { type ReactNode, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncClient } from "../local/sync.js";
import {
  accountGids,
  accountRows,
  ErrorBoundary,
  explode,
  Fallback,
  Fragile,
  fallbackMounts,
  profileName,
} from "../testing/fixtures.js";
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

function setup() {
  const stores = memoryStores();
  const client = createSyncClient(stores, { lingerMs: 0 });
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
    stores.close();
  });
  return { stores, client, wrapper, fallbacks: () => fallbackMounts.count };
}

describe("useQuery (sync adapter)", () => {
  it("returns rows on the first render and never suspends", () => {
    const { wrapper, fallbacks } = setup();
    const { result } = renderHook(() => useQuery(profileName), { wrapper });
    expect(result.current).toBe("Ala");
    expect(fallbacks()).toBe(0);
  });

  it("re-renders exactly the readers of the tables a command touched", async () => {
    const { wrapper } = setup();
    let nameRenders = 0;
    let accountRenders = 0;
    const name = renderHook(
      () => {
        nameRenders += 1;
        return useQuery(profileName);
      },
      { wrapper },
    );
    renderHook(
      () => {
        accountRenders += 1;
        return useQuery(accountRows);
      },
      { wrapper },
    );
    const rename = renderHook(() => useCommand(renameProfile), { wrapper });
    const [names0, accounts0] = [nameRenders, accountRenders];

    await act(() => rename.result.current.run({ name: "Ela" }));
    expect(name.result.current).toBe("Ela");
    expect(nameRenders).toBeGreaterThan(names0);
    expect(accountRenders).toBe(accounts0);
  });

  it("shares structure: unchanged rows keep their identity, an equal result re-renders nobody", async () => {
    const { wrapper } = setup();
    const rows = renderHook(() => useQuery(accountRows), { wrapper });
    let gidRenders = 0;
    const gids = renderHook(
      () => {
        gidRenders += 1;
        return useQuery(accountGids);
      },
      { wrapper },
    );
    const open = renderHook(() => useCommand(openAccount), { wrapper });
    const rename = renderHook(() => useCommand(renameAccount), { wrapper });
    for (const name of ["Konto", "Lokata"]) {
      await act(async () => {
        const r = await open.result.current.run({
          bank: "mbank",
          name,
          type: "checking",
          currency: "PLN",
        });
        expect(r.kind).toBe("completed");
      });
    }
    const before = rows.result.current;
    const gidsBefore = gids.result.current;
    const rendersBefore = gidRenders;
    expect(before.map((r) => r.name)).toEqual(["Konto", "Lokata"]);

    await act(async () => {
      expect(
        await rename.result.current.run({ account: before[1]?.gid as string, name: "Lokata 2" }),
      ).toEqual({ kind: "completed", value: null });
    });
    const after = rows.result.current;
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]?.name).toBe("Lokata 2");
    // accounts was touched, the gid list re-ran, came out equal: same snapshot, no render.
    expect(gids.result.current).toBe(gidsBefore);
    expect(gidRenders).toBe(rendersBefore);
  });

  it("shares one live query between readers and releases it after the last one leaves", async () => {
    const { wrapper, stores, client } = setup();
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
    const first = renderHook(() => useQuery(profileName), { wrapper });
    const second = renderHook(() => useQuery(profileName), { wrapper });
    expect(first.result.current).toBe("Ala");
    expect(second.result.current).toBe("Ala");
    expect(active).toBe(1);
    first.unmount();
    second.unmount();
    await waitFor(() => expect(active).toBe(0));
    // Only the device query of the (unmounted) ProfileProviders may remain until it is released too.
    await waitFor(() => expect(client.size).toBe(0));
  });
});

describe("useCommand (sync adapter)", () => {
  it("returns the result union for expected outcomes", async () => {
    const { wrapper } = setup();
    const create = renderHook(() => useCommand(createProfile), { wrapper });
    await act(async () => {
      expect(await create.result.current.run({ slug: "x", name: "X" })).toEqual({
        kind: "refused",
        reason: "exists",
      });
      expect(await create.result.current.run({ slug: 1 } as never)).toEqual({
        kind: "refused",
        reason: "invalid_input",
      });
    });
    expect(create.result.current.isPending).toBe(false);
  });

  it("settles an unexpected local command failure", async () => {
    const { wrapper } = setup();
    const command = renderHook(() => useCommand(explode), { wrapper });
    await act(async () => {
      expect((await command.result.current.run({})).kind).toBe("outcome_unknown");
    });
  });

  it("throws a failing query to the error boundary", async () => {
    const { wrapper } = setup();
    render(<Fragile />, { wrapper, onCaughtError: () => {} });
    act(() => screen.getByRole("button").click());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "boundary: cannot decode the profile",
    );
  });
});
