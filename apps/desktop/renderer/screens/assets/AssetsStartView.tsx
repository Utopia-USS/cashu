// `setup/assets` (ab24ab6 modules/assets/Start.tsx in core/StartPage.tsx): the assets first steps as a page, on the
// shared module start frame (no steps tag: assets is never partial), the Claude Code card under the steps and the
// add drawer shared with the Majątek widget.
import { S as A } from "@cashu/i18n/assets/index.strings";
import { S as CH } from "@cashu/i18n/core/chrome.strings";
import { ModuleStart } from "@cashu/ui";
import type { ReactNode } from "react";
import { AssetDrawerView } from "../overview/AssetsWidgetView.js";
import type { AssetDrawerState } from "../overview/useAssetDrawer.js";
import { assetStepItems } from "./AssetsStepsView.js";

export interface AssetsStartViewProps {
  /** null while loading: the steps widget shows three skeleton rows. */
  state: AssetDrawerState | null;
  today: string;
  baseCurrency: string;
  /** The `Z pomocą Claude Code` card under the steps; none while loading. */
  agent?: ReactNode;
}

export function AssetsStartView({ state, today, baseCurrency, agent }: AssetsStartViewProps) {
  return (
    <ModuleStart
      title={A.name}
      stepsTitle={CH.firstSteps}
      steps={
        state ? assetStepItems(state.steps, (type) => state.openNew(type, baseCurrency)) : null
      }
      below={agent}
    >
      {state && <AssetDrawerView state={state} today={today} />}
    </ModuleStart>
  );
}
