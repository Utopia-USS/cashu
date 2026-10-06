// `setup/assets` (old links, Settings): the assets first steps as a page (design/v3/first-steps section 10).
// The everyday entry is the Majątek widget on Przegląd, which shows the same steps while the module is empty.
// After a save: Przegląd with the widget ringed.
import { useState } from "react";
import { useShell } from "../../core/context";
import { StartPage, useSetupPoll } from "../../core/StartPage";
import type { ModuleCtx } from "../../core/types";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { todayLocal } from "../../time";
import { useToast } from "../../ui";
import { getManualAssets } from "./api";
import { AssetDrawer, type AssetTarget } from "./AssetsWidget";
import { assetStepItems } from "./Steps";

export function AssetsStart({ ctx }: { ctx: ModuleCtx }) {
  const { slug } = ctx;
  const toast = useToast();
  const { reloadProfiles } = useShell();
  const base = ctx.profile.base_currency;
  const [edit, setEdit] = useState<AssetTarget | null>(null);
  const setup = useSetupPoll(slug, "assets", ctx.state, edit != null);
  const manual = useAsync(() => getManualAssets(slug), [slug], { key: ck(slug, "assets-manual") });
  const rows = manual.data ? manual.data.filter((a) => !a.is_liability) : null;
  const steps = rows ? assetStepItems(rows, base, (type) => setEdit({ kind: "new", type })) : null;
  return (
    <StartPage moduleId="assets" title="Majątek" setup={setup.data} state={ctx.state} steps={steps} tag={false}>
      {edit && (
        <AssetDrawer target={edit} slug={slug} base={base} today={todayLocal()} onClose={() => setEdit(null)}
          onRemoved={() => setEdit(null)}
          onSaved={(created) => {
            setEdit(null);
            toast(created ? "Dodano" : "Zapisano");
            ctx.refresh();
            void reloadProfiles();
            ctx.go({ kind: "tab", tab: "overview", sub: "assets" });
          }} />
      )}
    </StartPage>
  );
}
