// What the host serves on the store channel: the queries and commands a `ui` session may use, by id.
// Anything not listed is refused (the renderer is sandboxed and not trusted). Same set as the S53 store
// process; screens add theirs here as they move onto the store (S55 series).
import { type Command, createProfile, renameProfile, setProfileSettings } from "@cashu/store";
import { profile } from "@cashu/store/core";
import { currentVault, type DeviceCommand, setCurrentVault } from "@cashu/store/device";
import { legacyNavigation, overviewQueries, profileIdentity } from "@cashu/store/overview";
import type { Query, QueryArgs } from "@cashu/store/query";

/** A vault command or a device command (its own `scope` says which store it writes). */
export type AnyCommand = Command<unknown, unknown> | DeviceCommand<unknown, unknown>;

/** Process-local providers are bound here, never supplied by the renderer. */
export function servedQueries(
  env: Parameters<typeof overviewQueries>[0] & {
    readonly legacyIdentity?: Parameters<typeof legacyNavigation>[0];
  } = { prices: null },
): readonly Query<QueryArgs, unknown>[] {
  return [
    currentVault,
    profile,
    profileIdentity,
    legacyNavigation(env.legacyIdentity),
    ...Object.values(overviewQueries(env)),
  ];
}

export const SERVED_QUERIES = servedQueries();

export const SERVED_COMMANDS: readonly AnyCommand[] = [
  setCurrentVault,
  createProfile,
  renameProfile,
  setProfileSettings,
] as readonly AnyCommand[];

export function isDeviceCommand(command: AnyCommand): command is DeviceCommand<unknown, unknown> {
  return "scope" in command && command.scope === "device";
}
