import { builtinRegistry } from "@cashu/domain/core";
import { ToolError } from "@cashu/mcp";
import { mcpProfile } from "@cashu/store/core";
import type { HostStores, OpenVault } from "../stores.js";
import type { WorkspaceProvider } from "../workspace/index.js";
import { investmentMappingReader } from "./files.js";

/** Resolve a profile-only YAML mapping through the checked, owner-marked native workspace. */
export function nativeMappingReader(options: {
  readonly workspace?: WorkspaceProvider;
  readonly stores: Pick<HostStores, "vaults">;
  readonly vault: OpenVault;
  readonly replaced: () => boolean;
  readonly fileScope: Parameters<typeof investmentMappingReader>[0];
}): (rawPath: string, slug: string) => Promise<string> {
  const unavailable = (): never => {
    throw new ToolError("native workspace mapping is unavailable", "unsupported");
  };
  return async (rawPath, slug) => {
    const { vault, stores } = options;
    const binding = options.workspace?.bind(vault.id);
    const profile = mcpProfile(vault.store.read.bind(vault.store));
    if (
      !binding ||
      !profile ||
      profile.slug !== slug ||
      !profile.modules.includes("investments") ||
      (profile.mcpPrivacy !== "strict" && profile.mcpPrivacy !== "amounts")
    )
      return unavailable();
    const modules = [...builtinRegistry().modules.values()]
      .filter((module) => profile.modules.includes(module.id))
      .map((module) => ({ id: module.id, name: module.name }));
    const input = {
      slug,
      modules,
      privacy: profile.mcpPrivacy as "strict" | "amounts",
      baseCurrency: profile.baseCurrency,
    };
    const current = () =>
      !options.replaced() &&
      stores.vaults.get(vault.id) === vault &&
      vault.native?.isCurrent() === true &&
      binding.isCurrent() &&
      JSON.stringify(mcpProfile(vault.store.read.bind(vault.store))) === JSON.stringify(profile);
    if (!current()) return unavailable();
    const status = await binding.inspect(input);
    if (!current() || status.availability !== "ready" || !status.exists || status.conflict !== null)
      return unavailable();
    const value = investmentMappingReader({
      ...options.fileScope,
      profileOnlyRoot: status.path,
      profileOnlySlug: slug,
    })(rawPath, slug);
    const after = await binding.inspect(input);
    if (
      !current() ||
      after.availability !== "ready" ||
      !after.exists ||
      after.conflict !== null ||
      after.path !== status.path
    )
      return unavailable();
    return value;
  };
}
