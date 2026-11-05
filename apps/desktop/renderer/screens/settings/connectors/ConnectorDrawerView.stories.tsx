import { UiEnvProvider } from "@cashu/ui";
import { ConnectorDrawerView } from "./ConnectorDrawerView.js";
import { connectorsState, syntheticConnector } from "./storyState.js";

export default { title: "Desktop/Settings/Connectors/Drawer", component: ConnectorDrawerView };
export const Approved = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy={false}>
      <ConnectorDrawerView
        connector={syntheticConnector}
        state={connectorsState}
        onClose={() => {}}
      />
    </UiEnvProvider>
  ),
};
export const Pending = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy={false}>
      <ConnectorDrawerView
        connector={{ ...syntheticConnector, approval: "pending" }}
        state={connectorsState}
        onClose={() => {}}
      />
    </UiEnvProvider>
  ),
};
