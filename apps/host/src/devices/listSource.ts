/** The served Ustawienia > Urządzenia list: each vault's device list checked in its native session queue and
 * pushed again after every sync pass and device change, while a screen listens (no renderer re-read). */
import type { DeviceListSource, DeviceListState } from "@cashu/store/core/desktop-settings";
import type { NativeVaultSession } from "../nativeVault.js";
import type { HostStores } from "../stores.js";

/** `stores()` is the host's opened stores; its vault set is fixed for the host's lifetime (a new vault hands
 * over to a fresh host), so the sessions are taken when the first screen starts listening. */
export function deviceListSource(stores: () => HostStores | null): DeviceListSource {
  const listeners = new Set<() => void>();
  const images = new Map<string, { session: NativeVaultSession; state: DeviceListState }>();
  const checking = new Set<string>();
  const scheduled = new Set<string>();
  const again = new Set<string>();
  let stopSessions: (() => void)[] = [];
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const session = (vault: string) => {
    const native = stores()?.vaults.get(vault)?.native;
    return native?.isCurrent() ? native : undefined;
  };
  const check = (vault: string) => {
    if (checking.has(vault)) {
      again.add(vault);
      return;
    }
    const current = session(vault);
    if (!current) {
      if (images.delete(vault)) emit();
      return;
    }
    checking.add(vault);
    void current
      .deviceList()
      .then(
        (list): DeviceListState => ({ status: "ready", list }),
        (): DeviceListState => ({ status: "unavailable" }),
      )
      .then((state) => {
        checking.delete(vault);
        if (again.delete(vault)) {
          check(vault);
          return;
        }
        if (listeners.size === 0 || session(vault) !== current) return;
        images.set(vault, { session: current, state });
        emit();
      });
  };
  return {
    changes: {
      subscribe(listener) {
        if (listeners.size === 0) {
          // Nothing re-checked the lists while no screen listened: start from fresh checks.
          images.clear();
          stopSessions = [...(stores()?.vaults ?? [])].flatMap(([id, vault]) =>
            vault.native === undefined
              ? []
              : [
                  vault.native.onDevicesChanged(() => {
                    if (images.has(id) || checking.has(id)) check(id);
                  }),
                ],
          );
        }
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          if (listeners.size > 0) return;
          for (const stop of stopSessions) stop();
          stopSessions = [];
        };
      },
    },
    state(vault) {
      const current = session(vault);
      if (!current) return { status: "unavailable" };
      const image = images.get(vault);
      if (image?.session === current) return image.state;
      if (!checking.has(vault) && !scheduled.has(vault)) {
        scheduled.add(vault);
        queueMicrotask(() => {
          scheduled.delete(vault);
          if (!checking.has(vault)) check(vault);
        });
      }
      return { status: "loading" };
    },
  };
}
