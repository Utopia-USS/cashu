// What the store process serves to the renderer: the queries and commands screens may use, by id.
// Anything not listed here is refused at the port (the renderer is sandboxed and not trusted).
import { createProfile, renameProfile, setProfileSettings } from "@cashu/store";
import { profile } from "@cashu/store/core";
import { currentVault, setCurrentVault } from "@cashu/store/device";
import type { Query, QueryArgs } from "@cashu/store/query";
import type { AnyCommand } from "@cashu/store-react/client";

export const SERVED_QUERIES: readonly Query<QueryArgs, unknown>[] = [currentVault, profile];

export const SERVED_COMMANDS: readonly AnyCommand[] = [
  setCurrentVault,
  createProfile,
  renameProfile,
  setProfileSettings,
];
