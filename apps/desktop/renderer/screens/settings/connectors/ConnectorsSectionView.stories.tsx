import { UiEnvProvider } from "@cashu/ui";
import { ConnectorsSectionView } from "./ConnectorsSectionView.js";
import { connectorsState, emptyConnectorsState } from "./storyState.js";

export default { title: "Desktop/Settings/Connectors/Section", component: ConnectorsSectionView };
export const Ready = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy={false}>
      <ConnectorsSectionView state={connectorsState} />
    </UiEnvProvider>
  ),
};
export const Empty = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy={false}>
      <ConnectorsSectionView state={emptyConnectorsState} />
    </UiEnvProvider>
  ),
};
