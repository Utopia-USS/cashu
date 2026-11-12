// The profile sheet's hook: this device's profiles (from the services, read at boot), the current one,
// incognito and what waits for the owner on the Mac. Switching runs the device command and closes.
import { pendingProposalsCount } from "@cashu/store/core/profile";
import { setCurrentVault } from "@cashu/store/device";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import Constants from "expo-constants";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import { initialOf } from "../../shell/tabs";
import { useIncognito } from "../../shell/useAppEnv";
import { S } from "./Profile.strings";

export type ProfileSheetState = {
  kind: "ready";
  profiles: {
    vault: string;
    name: string;
    initial: string;
    current: boolean;
    modules: string[];
  }[];
  incognito: boolean;
  isSwitching: boolean;
  /** The last switch was refused or failed; the sheet stays open and says so. */
  switchFailed: boolean;
  waiting: { kind: "nothing" } | { kind: "proposals"; count: number };
  version: string;
  dev: boolean;
  onProfilePicked(vault: string): void;
  onIncognitoToggle(): void;
  onDiagnostics(): void;
  onBench(): void;
  onClose(): void;
};

const MODULE_NAMES: Readonly<Record<string, () => string>> = {
  budget: () => S.moduleBudget,
  assets: () => S.moduleAssets,
  loans: () => S.moduleLoans,
  investments: () => S.moduleInvestments,
};

export function useProfileSheet(args: {
  close(): void;
  openDiagnostics(): void;
  openBench(): void;
}): ProfileSheetState {
  const { profiles } = useServices();
  const current = useProfile();
  const pending = useQuery(pendingProposalsCount);
  const incognito = useIncognito();
  const switchVault = useCommand(setCurrentVault);
  const [switchFailed, setSwitchFailed] = useState(false);
  return {
    kind: "ready",
    profiles: profiles.map((p) => ({
      vault: p.vault,
      name: p.name,
      initial: initialOf(p.name),
      current: p.vault === current,
      modules: p.modules.flatMap((id) => {
        const name = MODULE_NAMES[id];
        return name === undefined ? [] : [name()];
      }),
    })),
    incognito: incognito.on,
    isSwitching: switchVault.isPending,
    switchFailed,
    waiting: pending > 0 ? { kind: "proposals", count: pending } : { kind: "nothing" },
    version: Constants.expoConfig?.version ?? "",
    dev: __DEV__,
    onProfilePicked: (vault) => {
      if (vault === current) return args.close();
      setSwitchFailed(false);
      void switchVault.run({ vault }).then(
        (outcome) => {
          if (outcome.kind === "completed") args.close();
          else setSwitchFailed(true);
        },
        () => setSwitchFailed(true),
      );
    },
    onIncognitoToggle: incognito.toggle,
    onDiagnostics: args.openDiagnostics,
    onBench: args.openBench,
    onClose: args.close,
  };
}
