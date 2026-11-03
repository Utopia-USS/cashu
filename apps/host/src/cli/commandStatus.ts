import { mcpProfile } from "@cashu/store/core";
import { lookupHostVaultCommandStatus } from "../commands.js";
import type { HostStores } from "../stores.js";
import type { CommandIo, PortedCommand } from "./tree.js";

const DELEGATE = { kind: "delegate" } as const;

/** Status only. This path must never submit the command again. */
export function commandStatusCommand(stores: Pick<HostStores, "vaults">): PortedCommand {
  return {
    name: "command-status",
    async run(args: readonly string[], io: CommandIo, root: { readonly profile?: string }) {
      const slug = root.profile || io.env.CASHU_PROFILE;
      const [commandId, key] = args;
      if (
        !slug ||
        args.length !== 2 ||
        !commandId ||
        !/^[a-z][a-zA-Z0-9.]+$/.test(commandId) ||
        !key ||
        !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(key)
      )
        return DELEGATE;
      const matches = [...stores.vaults.values()].filter(
        (vault) => mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
      );
      if (matches.length !== 1 || !matches[0]) return DELEGATE;
      const status = lookupHostVaultCommandStatus(matches[0], commandId, key);
      io.stdout(`${status}: ${commandId} ${key}\n`);
      return status === "completed" ? 0 : 1;
    },
  };
}
