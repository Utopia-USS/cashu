// One vault's sync status for the screens: the session's current status, a new render on the
// session's emit, the stable `failed` status of a paired vault this launch could not open, and undefined
// for a vault the phone does not hold. A hand-driven session stands in for the engine; synthetic ids only.
import { act, cleanup, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { moneyStore } from "../screens/testing/moneyStore";
import { ServicesProvider } from "../services/ServicesProvider";
import type { Services } from "../services/services";
import type { VaultSession, VaultSyncStatus } from "../services/vaultEngine";
import { useVaultSyncStatus } from "./usePhoneSync";

const HELD = "1a2b3c4d5e6f708192a3b4c5d6e7f801";
const BROKEN = "2a2b3c4d5e6f708192a3b4c5d6e7f802";
const UNKNOWN = "3a2b3c4d5e6f708192a3b4c5d6e7f803";

/** A session whose status the test sets; `emit` tells the subscribers, as the engine does. */
function drivenSession(initial: VaultSyncStatus) {
  let current = initial;
  const listeners = new Set<() => void>();
  const session = {
    vault: initial.vault,
    status: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as Pick<VaultSession, "vault" | "status" | "subscribe"> as VaultSession;
  return {
    session,
    emit(next: VaultSyncStatus) {
      current = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

const closers: (() => void)[] = [];
afterEach(async () => {
  await cleanup();
  for (const close of closers.splice(0)) close();
});

function servicesWith(session: VaultSession, broken: VaultSyncStatus): Services {
  const kit = moneyStore();
  closers.push(kit.close);
  return {
    ...kit.services,
    vaults: {
      get: (vault) => (vault === session.vault ? session : undefined),
      list: () => [session],
      unavailable: (vault) => (vault === broken.vault ? broken : undefined),
      unavailableVaults: () => [{ vault: broken.vault, name: "Dom", failure: "needs_repair" }],
    },
  };
}

describe("useVaultSyncStatus", () => {
  const receiving: VaultSyncStatus = {
    vault: HELD,
    phase: "receiving",
    syncing: true,
    remote: true,
    unpushed: false,
  };
  const failed: VaultSyncStatus = {
    vault: BROKEN,
    phase: "failed",
    syncing: false,
    remote: true,
    unpushed: false,
    failure: "needs_repair",
  };

  it("returns the session's status and follows its emit; unsubscribes on unmount", async () => {
    const driven = drivenSession(receiving);
    const services = servicesWith(driven.session, failed);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ServicesProvider services={services}>{children}</ServicesProvider>
    );
    const hook = await renderHook(() => useVaultSyncStatus(HELD), { wrapper });
    expect(hook.result.current).toEqual(receiving);
    expect(driven.listeners.size).toBe(1);
    const ready: VaultSyncStatus = { ...receiving, phase: "ready", syncing: false, lastPullAt: 7 };
    await act(async () => driven.emit(ready));
    expect(hook.result.current).toEqual(ready);
    await hook.unmount();
    expect(driven.listeners.size).toBe(0);
  });

  it("reads a paired vault that did not open as failed, and an unknown vault as undefined", async () => {
    const driven = drivenSession(receiving);
    const services = servicesWith(driven.session, failed);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ServicesProvider services={services}>{children}</ServicesProvider>
    );
    const broken = await renderHook(() => useVaultSyncStatus(BROKEN), { wrapper });
    expect(broken.result.current).toEqual(failed);
    const unknown = await renderHook(() => useVaultSyncStatus(UNKNOWN), { wrapper });
    expect(unknown.result.current).toBeUndefined();
    // Neither subscribes to another vault's session.
    expect(driven.listeners.size).toBe(0);
  });
});
