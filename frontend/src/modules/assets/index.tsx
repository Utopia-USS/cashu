// Frontend half of the assets module (F7 merge, design/v2/networth-merge): no tab; the module owns the Majątek
// widget on Przegląd (list, add, edit, remove), contributed through the overview slot. A tab route of the module
// (`#/<slug>/assets.list`, an old remembered view) resolves to Przegląd with this widget focused (core/util.ts
// resolveView).
import type { ModuleDef } from "../../core/types";
import { AssetsWidget } from "./AssetsWidget";

export const assets: ModuleDef = {
  id: "assets",
  name: "Majątek",
  desc: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  short: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  tabs: [],
  // In the side stack right of `Wartość netto w czasie`, above Kredyty (50): assets, then liabilities.
  overview: [{ id: "list", span: 1, order: 45, stack: "side", Widget: AssetsWidget }],
};
