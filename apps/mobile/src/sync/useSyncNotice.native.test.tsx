// Today's sync slot from a hand-driven vault status: the replay line only after ~1 s, the removed state
// offers "Remove this copy" and never runs it by itself, "Keep for now" puts the sync-off notice aside.
import { setLanguageForTests } from "@cashu/i18n";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { ServicesProvider } from "../services/ServicesProvider";
import type { Services } from "../services/services";
import type { VaultSession, VaultSyncStatus } from "../services/vaultEngine";
import { useSyncNotice } from "./useSyncNotice";

const VAULT = "4a2b3c4d5e6f708192a3b4c5d6e7f804";
const base: VaultSyncStatus = {
  vault: VAULT,
  phase: "ready",
  syncing: false,
  remote: true,
  unpushed: false,
};

function rig(initial: VaultSyncStatus) {
  let current = initial;
  const listeners = new Set<() => void>();
  const session = {
    vault: VAULT,
    status: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as Pick<VaultSession, "vault" | "status" | "subscribe"> as VaultSession;
  const services = {
    vaults: { get: () => session, unavailable: () => undefined },
  } as unknown as Services;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesProvider services={services}>{children}</ServicesProvider>
  );
  return {
    wrapper,
    emit(next: VaultSyncStatus) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

beforeEach(() => setLanguageForTests("en"));

it("shows the replay line only once the replay ran about a second", async () => {
  jest.useFakeTimers();
  try {
    const { wrapper, emit } = rig(base);
    const removeCopy = jest.fn(async () => undefined);
    const { result } = await renderHook(
      () => useSyncNotice({ vault: VAULT, profile: "Anna", removeCopy }),
      { wrapper },
    );
    await act(async () => emit({ ...base, replay: { done: 2, total: 5 } }));
    expect(result.current.line).toBeNull();
    await act(async () => jest.advanceTimersByTime(1100));
    expect(result.current.line).toEqual({
      text: "Checking this phone's copy · 40%",
      tone: "muted",
    });
    await act(async () => emit(base));
    expect(result.current.line).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

it("offers the removal of a removed phone's copy and runs it only on the owner's press", async () => {
  const { wrapper } = rig({ ...base, phase: "removed" });
  const removeCopy = jest.fn(async () => undefined);
  const { result } = await renderHook(
    () => useSyncNotice({ vault: VAULT, profile: "Anna", removeCopy }),
    { wrapper },
  );
  expect(result.current.notice?.title).toBe("This phone was removed from Anna on your Mac");
  expect(removeCopy).not.toHaveBeenCalled();
  await act(async () => result.current.notice?.actions[0]?.onPress());
  expect(removeCopy).toHaveBeenCalledWith(VAULT);
});

it("puts the sync-off notice aside with Keep for now", async () => {
  const { wrapper } = rig({ ...base, relay: { lastError: "forbidden", lastErrorAt: 1 } });
  const { result } = await renderHook(
    () => useSyncNotice({ vault: VAULT, profile: "Anna", removeCopy: async () => undefined }),
    { wrapper },
  );
  expect(result.current.notice?.actions.map((a) => a.label)).toEqual([
    "Remove this copy",
    "Keep for now",
  ]);
  await act(async () => result.current.notice?.actions[1]?.onPress());
  expect(result.current.notice).toBeNull();
});

it("says another device, never an id, while the registry cannot name a stuck writer", async () => {
  const writer = { device: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", since: Date.now() };
  const { wrapper, emit } = rig({ ...base, stuck: [{ ...writer, kind: "waiting" }] });
  const { result } = await renderHook(
    () => useSyncNotice({ vault: VAULT, profile: "Anna", removeCopy: async () => undefined }),
    { wrapper },
  );
  expect(result.current.line).toEqual({
    text: "Some changes from another device can't be read yet. Sync keeps trying.",
    tone: "muted",
  });
  await act(async () => emit({ ...base, stuck: [{ ...writer, kind: "final" }] }));
  expect(result.current.line).toEqual({
    text: "Changes from another device can't be read. Check Devices on your Mac.",
    tone: "warning",
  });
  setLanguageForTests("pl");
  await act(async () => emit({ ...base, stuck: [{ ...writer, kind: "waiting" }] }));
  expect(result.current.line?.text).toBe(
    "Części zmian z innego urządzenia nie da się jeszcze odczytać. Synchronizacja próbuje dalej.",
  );
  await act(async () => emit({ ...base, stuck: [{ ...writer, kind: "rejected" }] }));
  expect(result.current.line?.text).toBe(
    "Nie da się odczytać zmian z innego urządzenia. Sprawdź Urządzenia na Macu.",
  );
});
