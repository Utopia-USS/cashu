import { mcpProfile } from "@cashu/store/core";
import type { HostStores, OpenVault } from "../stores.js";
import { N } from "./native.strings.js";
import type { CommandIo } from "./tree.js";

export interface LoanAssetDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
}

export function selectedVault(
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): OpenVault | null {
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug) {
    io.stderr(`${io.t.tr(N.selectProfile)}\n`);
    return null;
  }
  const matches = [...deps.stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === slug,
  );
  if (matches.length !== 1) {
    io.stderr(`${io.t.tr(N.missingProfile)}\n`);
    return null;
  }
  return matches[0] ?? null;
}

export function stillSelected(
  vault: OpenVault,
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): () => boolean {
  const slug = root.profile || io.env.CASHU_PROFILE;
  return () =>
    !io.signal.aborted &&
    deps.stores.vaults.get(vault.id) === vault &&
    mcpProfile(vault.store.read.bind(vault.store))?.slug === slug;
}

export function localDay(now: number): string {
  const day = new Date(now);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

export function usage(io: CommandIo, text: string): number {
  io.stderr(`${text}\n`);
  return 2;
}
