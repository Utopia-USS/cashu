// `setup/assets` (ab24ab6 modules/assets/Start.tsx in core/StartPage.tsx): the assets first steps as a page, on the
// shared module start frame (no steps tag: assets is never partial), the steps widget's footer linking the
// Claude Code / CLI guide, the Agent AI widget beside it and the add drawer shared with the Majątek widget.
import { S as A } from "@cashu/i18n/assets/index.strings";
import { S as CH } from "@cashu/i18n/core/chrome.strings";
import { AgentWidget, Button, ModuleStart } from "@cashu/ui";
import { AssetDrawerView } from "../overview/AssetsWidgetView.js";
import type { AssetDrawerState } from "../overview/useAssetDrawer.js";
import { assetStepItems } from "./AssetsStepsView.js";

export interface AssetsStartViewProps {
  /** null while loading: the steps widget shows three skeleton rows. */
  state: AssetDrawerState | null;
  today: string;
  baseCurrency: string;
  privacy: boolean;
  /** The profile's MCP privacy level for the Agent AI widget beside the steps; null while loading (no widget). */
  mcpPrivacy: string | null;
  onGuide(): void;
  /** `Ustawienia` of the Agent AI widget: Ustawienia › Agent AI. */
  onAgentSettings(): void;
}

export function AssetsStartView({
  state,
  today,
  baseCurrency,
  privacy,
  mcpPrivacy,
  onGuide,
  onAgentSettings,
}: AssetsStartViewProps) {
  return (
    <ModuleStart
      title={A.name}
      stepsTitle={CH.firstSteps}
      footer={
        <Button variant="link" size="sm" onPress={onGuide}>
          {CH.cliGuide}
        </Button>
      }
      steps={
        state
          ? assetStepItems(state.steps, privacy, (type) => state.openNew(type, baseCurrency))
          : null
      }
      aside={
        mcpPrivacy === null ? undefined : (
          <AgentWidget privacy={mcpPrivacy} onSettings={onAgentSettings} />
        )
      }
    >
      {state && <AssetDrawerView state={state} today={today} privacy={privacy} />}
    </ModuleStart>
  );
}
