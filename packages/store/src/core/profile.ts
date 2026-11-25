// The profile identity and enabled modules of one vault (`@cashu/store/core/profile`). Its own entry
// so the phone, whose bundler (Metro) does not tree-shake, reads who a vault is and which modules it
// shows without the core barrel (proposals, connector bindings) or the overview's desktop widgets.
import { core } from "@cashu/domain";
import { defineQuery } from "../query.js";

/** Public identity of this vault only, for profile routes and the device's open-vault picker. */
export const profileIdentity = defineQuery({
  id: "core.profileIdentity",
  run: (read): { slug: string; name: string; baseCurrency: string } | null =>
    read<{ slug: string; name: string; baseCurrency: string }>(
      "SELECT slug, name, base_currency AS baseCurrency FROM profiles",
    )[0] ?? null,
});

const MODULE_ORDER: ReadonlyMap<string, number> = new Map(
  core.MODULE_IDS.map((id, index) => [id, index]),
);

/** Ids of the enabled modules, in `MODULE_IDS` order (an id the build does not know sorts last). */
export const enabledModules = defineQuery({
  id: "core.enabledModules",
  run: (read): readonly string[] =>
    read<{ module_id: string }>("SELECT module_id FROM profile_modules WHERE enabled = 1")
      .map((r) => r.module_id)
      .sort(
        (a, b) =>
          (MODULE_ORDER.get(a) ?? MODULE_ORDER.size) - (MODULE_ORDER.get(b) ?? MODULE_ORDER.size) ||
          (a < b ? -1 : a > b ? 1 : 0),
      ),
});

/** How many agent proposals wait for the owner's decision (any kind; decided on the Mac). */
export const pendingProposalsCount = defineQuery({
  id: "core.pendingProposalsCount",
  run: (read): number =>
    read<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'")[0]?.n ?? 0,
});
