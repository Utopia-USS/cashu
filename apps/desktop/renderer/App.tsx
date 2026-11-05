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
  onComplete,
  onClosed,
  onLifetimeEnded,
  onVaultChanged,
}: {
  privacy: boolean;
  bridge: CreationBridge | null;
  onReady: (locator: NativeCreationReady, sourceVault?: string) => Promise<boolean>;
  onComplete: (locator: NativeCreationReady) => Promise<void>;
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
  // The wizard brings its own overlay (WizardFrame `overlay`: scrim over the dimmed app, old `.overlay`).
  return (
    <CreationScreen
      key={`additional:${vault}:${privacy}`}
      mode="additional"
      bridge={bridge}
      onReady={(locator) => onReady(locator, vault)}
      onComplete={onComplete}
      onClosed={onClosed}
    />
  );
}

export function App({ client }: { client: StoreClient }) {
  const [additional, setAdditional] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [firstCreation] = useState(() => client.vaults.length === 0);
  const [firstCompleted, setFirstCompleted] = useState(false);
  const hostEpoch = useRef(0);
  const privacy = useSyncExternalStore(onIncognitoChange, isIncognito);
  const bridge = creationBridge();
  const lifetime = useRef(new CreationTransition());
  const cancelWait = useRef<(() => void) | null>(null);
  const verified = useRef<{
    vaultId: string;
    profileSlug: string;
    sourceVault?: string;
    privacy: boolean;
    generation: number;
    hostEpoch: number;
  } | null>(null);
  useEffect(() => {
    let previous = client.connection.getSnapshot();
    return client.connection.subscribe(() => {
      const next = client.connection.getSnapshot();
      if (next !== previous) {
        previous = next;
        hostEpoch.current++;
        verified.current = null;
      }
    });
  }, [client]);
  const [endLifetime] = useState(() => () => {
    lifetime.current.end();
    cancelWait.current?.();
    verified.current = null;
  });
  const [onVaultChanged] = useState(() => (vault: string) => {
    if (!lifetime.current.vaultChanged(vault)) {
      cancelWait.current?.();
      verified.current = null;
    }
  });
  useEffect(() => {
    endLifetime();
    return endLifetime;
  }, [privacy, endLifetime]);
  useEffect(() => {
    if (!bridge || client.vaults.length === 0 || (firstCreation && !firstCompleted)) return;
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
  }, [bridge, client, firstCompleted, firstCreation]);
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
    if (
      client.connection.getSnapshot() !== "online" &&
      client.connection.getSnapshot() !== "recovered"
    )
      return false;
    verified.current = {
      vaultId: locator.vaultId,
      profileSlug: locator.profileSlug,
      sourceVault,
      privacy,
      generation,
      hostEpoch: hostEpoch.current,
    };
    return true;
  };
  const onComplete = async (locator: NativeCreationReady): Promise<void> => {
    const receipt = verified.current;
    if (
      receipt === null ||
      receipt.vaultId !== locator.vaultId ||
      receipt.profileSlug !== locator.profileSlug ||
      receipt.privacy !== isIncognito() ||
      receipt.hostEpoch !== hostEpoch.current ||
      !lifetime.current.active(receipt.generation) ||
      !client.vaults.includes(locator.vaultId)
    )
      throw new Error("creation_lifetime_changed");
    if (receipt.sourceVault !== undefined) {
      const selectedEntry = client.entry(DEVICE_TARGET, currentVault, undefined);
      await selectedEntry.ready;
      const selectedSnapshot = selectedEntry.getSnapshot();
      if (
        selectedSnapshot.status !== "value" ||
        selectedSnapshot.value !== receipt.sourceVault ||
        !lifetime.current.active(receipt.generation)
      )
        throw new Error("creation_source_changed");
    }
    if (
      verified.current !== receipt ||
      receipt.hostEpoch !== hostEpoch.current ||
      receipt.privacy !== isIncognito() ||
      !lifetime.current.active(receipt.generation) ||
      !client.vaults.includes(locator.vaultId)
    )
      throw new Error("creation_lifetime_changed");
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
    if (
      selected.kind !== "completed" ||
      !lifetime.current.active(receipt.generation) ||
      receipt.hostEpoch !== hostEpoch.current ||
      isIncognito() !== receipt.privacy
    ) {
      lifetime.current.clearExpected();
      throw new Error("creation_selection_failed");
    }
    setConnectionEpoch((value) => value + 1);
    setAdditional(false);
    await router.navigate({
      to: "/$slug/overview",
      params: { slug: locator.profileSlug },
      search: { vault: locator.vaultId },
    });
    verified.current = null;
    setFirstCompleted(true);
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
              {firstCreation && !firstCompleted ? (
                <CreationScreen
                  key={`first:${privacy}`}
                  mode="first"
                  bridge={bridge}
                  onReady={onReady}
                  onComplete={onComplete}
                />
              ) : (
                <ProfileProvider fallback={<p className="p-6">{S.noProfile}</p>}>
                  <div aria-hidden={additional || undefined} inert={additional}>
                    <RouterProvider key={connectionEpoch} router={router} />
                  </div>
                  {additional && (
                    <AdditionalCreationOverlay
                      privacy={privacy}
                      bridge={bridge}
                      onReady={onReady}
                      onComplete={onComplete}
                      onClosed={() => {
                        lifetime.current.clearExpected();
                        setAdditional(false);
                      }}
                      onLifetimeEnded={endLifetime}
                      onVaultChanged={onVaultChanged}
                    />
                  )}
                </ProfileProvider>
              )}
            </CreationContext>
          </NotificationRouteController>
        </Suspense>
      </RootBoundary>
    </StoreProvider>
  );
}
