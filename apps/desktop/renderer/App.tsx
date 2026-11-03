import type { NativeCreationReady } from "@cashu/host-protocol";
import { currentVault, setCurrentVault } from "@cashu/store/device";
import { profileIdentity } from "@cashu/store/overview";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { DEVICE_TARGET, type StoreClient } from "@cashu/store-react/client";
import { isIncognito, onIncognitoChange } from "@cashu/ui-logic/core/incognito";
import { RouterProvider } from "@tanstack/react-router";
import {
  Component,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type CreationBridge, creationBridge } from "./creationBridge.js";
import { CreationContext } from "./creationContext.js";
import { CreationTransition } from "./creationTransition.js";
import { S } from "./Desktop.strings.js";
import { NotificationRouteController } from "./NotificationRouteController.js";
import { RouteFailure, router } from "./routes.js";
import { CreationScreen } from "./screens/onboarding/CreationScreen.js";

class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <RouteFailure /> : this.props.children;
  }
}

function AdditionalCreationOverlay({
  privacy,
  bridge,
  onReady,
  onClosed,
  onLifetimeEnded,
  onVaultChanged,
}: {
  privacy: boolean;
  bridge: CreationBridge | null;
  onReady: (locator: NativeCreationReady, sourceVault?: string) => Promise<boolean>;
  onClosed: () => void;
  onLifetimeEnded: () => void;
  onVaultChanged: (vault: string) => void;
}) {
  const vault = useProfile();
  const previousVault = useRef(vault);
  useEffect(() => {
    if (previousVault.current !== vault) onVaultChanged(vault);
    previousVault.current = vault;
  }, [vault, onVaultChanged]);
  useEffect(() => () => onLifetimeEnded(), [onLifetimeEnded]);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-surface">
      <CreationScreen
        key={`additional:${vault}:${privacy}`}
        mode="additional"
        bridge={bridge}
        onReady={(locator) => onReady(locator, vault)}
        onClosed={onClosed}
      />
    </div>
  );
}

export function App({ client }: { client: StoreClient }) {
  const [additional, setAdditional] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const privacy = useSyncExternalStore(onIncognitoChange, isIncognito);
  const bridge = creationBridge();
  const lifetime = useRef(new CreationTransition());
  const cancelWait = useRef<(() => void) | null>(null);
  const [endLifetime] = useState(() => () => {
    lifetime.current.end();
    cancelWait.current?.();
  });
  const [onVaultChanged] = useState(() => (vault: string) => {
    if (!lifetime.current.vaultChanged(vault)) cancelWait.current?.();
  });
  useEffect(() => {
    endLifetime();
    return endLifetime;
  }, [privacy, endLifetime]);
  useEffect(() => {
    if (!bridge || client.vaults.length === 0) return;
    let active = true;
    void bridge
      .current()
      .then((status) => {
        if (active && (status.kind === "pending" || status.kind === "outcome_unknown"))
          setAdditional(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [bridge, client]);
  const onReady = async (locator: NativeCreationReady, sourceVault?: string): Promise<boolean> => {
    const generation = lifetime.current.begin();
    const active = () => lifetime.current.active(generation) && isIncognito() === privacy;
    if (!client.vaults.includes(locator.vaultId)) {
      const appeared = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          stop();
          if (cancelWait.current === cancel) cancelWait.current = null;
          resolve(value);
        };
        const check = () => {
          if (!active()) finish(false);
          else if (
            (client.connection.getSnapshot() === "online" ||
              client.connection.getSnapshot() === "recovered") &&
            client.vaults.includes(locator.vaultId)
          )
            finish(true);
        };
        const cancel = () => finish(false);
        const stop = client.connection.subscribe(check);
        const timeout = setTimeout(cancel, 20_000);
        cancelWait.current = cancel;
        check();
      });
      if (!appeared || !active()) return false;
    }
    if (!active()) return false;
    const entry = client.entry(
      { kind: "vault", vault: locator.vaultId },
      profileIdentity,
      undefined,
    );
    await entry.ready;
    if (!active()) return false;
    const snapshot = entry.getSnapshot();
    if (snapshot.status !== "value" || snapshot.value?.slug !== locator.profileSlug) return false;
    if (sourceVault !== undefined) {
      const selectedEntry = client.entry(DEVICE_TARGET, currentVault, undefined);
      await selectedEntry.ready;
      const selectedSnapshot = selectedEntry.getSnapshot();
      if (
        !active() ||
        selectedSnapshot.status !== "value" ||
        selectedSnapshot.value !== sourceVault
      )
        return false;
    }
    if (!active()) return false;
    lifetime.current.expect(locator.vaultId);
    let selected: Awaited<ReturnType<typeof client.run>>;
    try {
      selected = await client.run(DEVICE_TARGET, setCurrentVault, {
        vault: locator.vaultId,
      });
    } catch (error) {
      lifetime.current.clearExpected();
      throw error;
    }
    if (selected.kind !== "completed" || !active()) {
      lifetime.current.clearExpected();
      return false;
    }
    setConnectionEpoch((value) => value + 1);
    setAdditional(false);
    await router.navigate({
      to: "/$slug/overview",
      params: { slug: locator.profileSlug },
      search: { vault: locator.vaultId },
    });
    return true;
  };
  return (
    <StoreProvider client={client}>
      <RootBoundary>
        <Suspense
          fallback={
            <p role="status" className="p-6">
              {S.waiting}
            </p>
          }
        >
          <NotificationRouteController>
            <CreationContext
              value={() => {
                lifetime.current.clearExpected();
                setAdditional(true);
              }}
            >
              <ProfileProvider
                fallback={
                  client.vaults.length === 0 ? (
                    <CreationScreen
                      key={`first:${privacy}`}
                      mode="first"
                      bridge={bridge}
                      onReady={onReady}
                    />
                  ) : (
                    <p className="p-6">{S.noProfile}</p>
                  )
                }
              >
                <div aria-hidden={additional || undefined} inert={additional}>
                  <RouterProvider key={connectionEpoch} router={router} />
                </div>
                {additional && (
                  <AdditionalCreationOverlay
                    privacy={privacy}
                    bridge={bridge}
                    onReady={onReady}
                    onClosed={() => {
                      lifetime.current.clearExpected();
                      setAdditional(false);
                    }}
                    onLifetimeEnded={endLifetime}
                    onVaultChanged={onVaultChanged}
                  />
                )}
              </ProfileProvider>
            </CreationContext>
          </NotificationRouteController>
        </Suspense>
      </RootBoundary>
    </StoreProvider>
  );
}
