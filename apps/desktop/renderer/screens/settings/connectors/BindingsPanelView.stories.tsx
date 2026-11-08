import { UiEnvProvider } from "@cashu/ui";
import { BindingsPanelView } from "./BindingsPanelView.js";
import { connectorsState, syntheticConnector } from "./testing/storyState.js";

export default { title: "Desktop/Settings/Connectors/Bindings", component: BindingsPanelView };
export const Bound = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy={false}>
      <BindingsPanelView connector={syntheticConnector} state={connectorsState} />
    </UiEnvProvider>
  ),
};
