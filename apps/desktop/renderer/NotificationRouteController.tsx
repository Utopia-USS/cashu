import { currentVault, setCurrentVault } from "@cashu/store/device";
import { profileIdentity } from "@cashu/store/overview";
import { isStale, useQuery, useStoreClient } from "@cashu/store-react";
import { DEVICE_TARGET, type StoreClient } from "@cashu/store-react/client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { onNotificationPending, onNotificationTarget } from "./notificationBridge.js";
import { NotificationSignalFocus } from "./notificationFocusContext.js";
import {
  notificationDestination,
  PendingNotificationNavigation,
} from "./notificationNavigation.js";
import { router } from "./routes.js";

function currentSelection(client: StoreClient): string {
  const snapshot = client.entry(DEVICE_TARGET, currentVault, undefined).getSnapshot();
  return snapshot.status === "value" ? (snapshot.value ?? "") : "";
}

/** Stays mounted while the profile route tree is unavailable during cold start or unlock. */
export function NotificationRouteController({ children }: { children: ReactNode }) {
  const client = useStoreClient();
  const selectedVault = useQuery(currentVault);
  const [signalFocus, setSignalFocus] = useState<{ vault: string; signalId: string } | null>(null);
  const pending = useRef(new PendingNotificationNavigation());
  const sequence = useRef(0);
  useEffect(() => {
    pending.current.observe(router.state.location.href, selectedVault ?? "");
  }, [selectedVault]);
  useEffect(
    () =>
      router.subscribe("onResolved", () => {
        const location = router.state.location;
        pending.current.observe(location.href, currentSelection(client));
        setSignalFocus((focus) =>
          focus !== null &&
          (!location.pathname.endsWith("/investments.portfolio") ||
            location.search.vault !== focus.vault ||
            location.search.signals !== "1")
            ? null
            : focus,
        );
      }),
    [client],
  );
  useEffect(() => {
    let mounted = true;
    const sequenceRef = sequence;
    const fallbackStops = new Set<() => void>();
    const stopPending = onNotificationPending(() => {
      ++sequence.current;
      pending.current.begin(router.state.location.href, currentSelection(client));
    });
    const stopTarget = onNotificationTarget((result) => {
      const clicked = sequence.current;
      void (async () => {
        let destination: ReturnType<typeof notificationDestination> = { kind: "unavailable" };
        if (
          result.kind === "target" &&
          !isStale(client.connection.getSnapshot()) &&
          client.vaults.includes(result.vaultId)
        ) {
          try {
            const entry = client.entry(
              { kind: "vault", vault: result.vaultId },
              profileIdentity,
              undefined,
            );
            await entry.ready;
            const snapshot = entry.getSnapshot();
            if (snapshot.status === "value" && snapshot.value !== null)
              destination = notificationDestination(
                result,
                [{ ...snapshot.value, vault: result.vaultId }],
                client.vaults,
              );
          } catch {
            // A missing or unreadable vault takes the neutral route.
          }
        }
        if (!mounted || sequence.current !== clicked) return;
        pending.current.observe(router.state.location.href, currentSelection(client));
        if (!pending.current.consume()) return;
        if (isStale(client.connection.getSnapshot())) destination = { kind: "unavailable" };
        const navigation = ++sequence.current;
        setSignalFocus(null);
        if (destination.kind === "unavailable") {
          void router.navigate({ to: "/" });
          return;
        }
        // Without an open selected vault, ProfileProvider cannot mount ProfileRouteSync.
        if (!client.vaults.includes(currentSelection(client))) {
          const before = router.state.location.href;
          const previous = currentSelection(client);
          const selectedEntry = client.entry(DEVICE_TARGET, currentVault, undefined);
          let override = false;
          let resolveObserved: (selected: boolean) => void = () => {};
          const observed = new Promise<boolean>((resolve) => {
            resolveObserved = resolve;
          });
          const checkSelection = () => {
            const current = currentSelection(client);
            if (current !== previous && current !== destination.vault) {
              override = true;
              resolveObserved(false);
            } else if (current === destination.vault) resolveObserved(true);
          };
          const stopSelection = selectedEntry.subscribe(checkSelection);
          const releaseSelection = () => {
            stopSelection();
            fallbackStops.delete(releaseSelection);
          };
          fallbackStops.add(releaseSelection);
          let switched = false;
          try {
            const outcome = await client.run(DEVICE_TARGET, setCurrentVault, {
              vault: destination.vault,
            });
            switched = outcome.kind === "completed";
          } catch {
            // An unknown command result is never retried automatically.
          }
          if (!mounted || sequence.current !== navigation) {
            releaseSelection();
            return;
          }
          checkSelection();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const confirmed = switched
            ? await Promise.race([
                observed,
                new Promise<boolean>((resolve) => {
                  timeout = setTimeout(() => resolve(false), 5_000);
                }),
              ])
            : false;
          clearTimeout(timeout);
          releaseSelection();
          if (!mounted || sequence.current !== navigation) return;
          const observedVault = currentSelection(client);
          if (
            override ||
            (observedVault !== previous && observedVault !== destination.vault) ||
            router.state.location.href !== before
          )
            return;
          if (!confirmed || observedVault !== destination.vault) {
            void router.navigate({ to: "/" });
            return;
          }
        }
        const navigate =
          destination.page === "overview"
            ? router.navigate({
                to: "/$slug/overview",
                params: { slug: destination.slug },
                search: { vault: destination.vault },
              })
            : router.navigate({
                to: "/$slug/investments.portfolio",
                params: { slug: destination.slug },
                search: {
                  vault: destination.vault,
                  period: "1y",
                  view: "chart",
                  ...(destination.page === "review"
                    ? { review: "1" as const }
                    : { signals: "1" as const }),
                },
              });
        const signalId = destination.signalId;
        if (signalId !== undefined)
          void navigate.then(() => {
            const location = router.state.location;
            if (
              mounted &&
              sequence.current === navigation &&
              location.pathname.endsWith("/investments.portfolio") &&
              location.search.vault === destination.vault &&
              location.search.signals === "1"
            )
              setSignalFocus({ vault: destination.vault, signalId });
          });
      })();
    });
    return () => {
      mounted = false;
      ++sequenceRef.current;
      for (const stop of fallbackStops) stop();
      stopPending();
      stopTarget();
    };
  }, [client]);
  const location = router.state.location;
  const activeFocus =
    signalFocus?.vault === selectedVault &&
    location.pathname.endsWith("/investments.portfolio") &&
    location.search.vault === signalFocus.vault &&
    location.search.signals === "1"
      ? signalFocus
      : null;
  return <NotificationSignalFocus value={activeFocus}>{children}</NotificationSignalFocus>;
}
