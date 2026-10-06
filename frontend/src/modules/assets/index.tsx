// Frontend half of the assets module (F7 merge, design/v2/networth-merge): no tab; the module owns the Majątek
// widget on Przegląd (list, add, edit, remove), contributed through the overview slot. A tab route of the module
// (`#/<slug>/assets.list`, an old remembered view) resolves to Przegląd with this widget focused (core/util.ts
// resolveView).
import type { ModuleDef } from "../../core/types";
import { AssetsWidget } from "./AssetsWidget";
import { AssetsStart } from "./Start";

export const assets: ModuleDef = {
  id: "assets",
  name: "Majątek",
  desc: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  short: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  tabs: [],
  // In the side stack right of `Wartość netto w czasie`, above Kredyty (50): assets, then liabilities.
  // `whenEmpty`: the widget is the module's first steps while it has no position (first-steps D6).
  overview: [{ id: "list", span: 1, order: 45, stack: "side", whenEmpty: true, Widget: AssetsWidget }],
  Start: AssetsStart,
};
