import { intlLocale, type Lang, lang, setLanguage } from "@cashu/i18n";
import { S as Connection } from "@cashu/i18n/core/hostConnection.strings";
import { setCurrentVault, setDevicePreferences } from "@cashu/store/device";
import { legacyNavigation, overviewQueries, profileIdentity } from "@cashu/store/overview";
import {
  isStale,
  useCommand,
  useConnection,
  useProfile,
  useQuery,
  useStoreClient,
} from "@cashu/store-react";
import type { StoreClient } from "@cashu/store-react/client";
import { isIncognito, onIncognitoChange, setIncognito } from "@cashu/ui-logic/core/incognito";
import { use, useState, useSyncExternalStore } from "react";
import { S } from "../Desktop.strings.js";
import { commandFailure, useDurableCommands } from "../screens/useDurableCommand.js";

const queries = overviewQueries({ prices: null });
const legacyQuery = legacyNavigation();

function openProfiles(client: StoreClient) {
  const entries = client.vaults.map((vault) => ({
    vault,
    entry: client.entry({ kind: "vault", vault }, profileIdentity, undefined),
  }));
  let snapshot = entries.map(({ entry }) => entry.getSnapshot());
  return {
    entries,
    subscribe: (listener: () => void) => {
      const stops = entries.map(({ entry }) => entry.subscribe(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
    getSnapshot: () => {
      const next = entries.map(({ entry }) => entry.getSnapshot());
      if (next.some((state, index) => state !== snapshot[index])) snapshot = next;
      return snapshot;
    },
  };
}

export function useShellScreen(args: {
  onProfileOpened(profile: { slug: string; vault: string }): void;
}) {
  const client = useStoreClient();
  const [source] = useState(() => openProfiles(client));
  const snapshots = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  for (const { entry } of source.entries) use(entry.ready);
  const profiles = snapshots.flatMap((state, index) => {
    if (state.status === "error") throw state.error;
    const vault = source.entries[index]?.vault;
    return state.status === "value" && state.value !== null && vault !== undefined
      ? [{ ...state.value, vault }]
      : [];
  });
  const profile = useQuery(profileIdentity);
  const modules = useQuery(queries.moduleStates);
  const legacyAvailable = useQuery(legacyQuery);
  const vault = useProfile();
  const switchProfile = useCommand(setCurrentVault);
  const savePreferences = useCommand(setDevicePreferences);
  const durable = useDurableCommands();
  const connection = useConnection();
  const privacy = useSyncExternalStore(onIncognitoChange, isIncognito);
  const [toast, setToast] = useState<string | null>(null);
  return {
    profile,
    profiles: profiles.map((row) => ({
      ...row,
      displayName:
        profiles.filter((other) => other.name === row.name).length > 1
          ? S.vaultProfile(row.name, row.vault.slice(0, 8))
          : row.name,
    })),
    vault,
    privacy,
    toast,
    connectionText: isStale(connection)
      ? `${Connection[connection]} ${Connection.stale}`
      : Connection[connection],
    language: lang(),
    locale: intlLocale(),
    enabledModules: modules.filter((module) => module.enabled).map((module) => module.id),
    canOpenLegacy:
      legacyAvailable &&
      profile !== null &&
      profiles.filter((row) => row.slug === profile.slug).length === 1,
    onLegacyRefused: () => setToast(S.legacyUnavailable),
    isSwitching: switchProfile.isPending,
    onPrivacyChanged: setIncognito,
    onLanguagePicked: async (value: Lang) => {
      const result = await durable.run("language", savePreferences, { languagePin: value });
      if (result.kind === "completed") setLanguage(value);
      else setToast(commandFailure(result, S.refused));
    },
    onProfilePicked: (next: string) => {
      const chosen = profiles.find((profile) => profile.vault === next);
      if (chosen === undefined) return;
      args.onProfileOpened(chosen);
    },
    onRouteVaultPicked: async (next: string) => {
      if (!profiles.some((profile) => profile.vault === next)) return;
      const result = await durable.run("profile-switch", switchProfile, { vault: next });
      setToast(result.kind === "completed" ? S.changed : commandFailure(result, S.refused));
    },
    onToastDismissed: () => setToast(null),
  };
}

export type ShellScreenState = ReturnType<typeof useShellScreen>;
