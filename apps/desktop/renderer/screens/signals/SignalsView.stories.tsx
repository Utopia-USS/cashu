import { UiEnvProvider } from "@cashu/ui";
import { SignalsDialogView, SignalsHomeRailView, SignalsPageView } from "./SignalsView.js";
import { useSignalsStoryState } from "./storyState.js";

function Story({
  page,
  dialog = false,
  privacy = false,
}: {
  page?: "alerts" | "watchlist" | "journal";
  dialog?: boolean;
  privacy?: boolean;
}) {
  const state = useSignalsStoryState(privacy);
  const shown = dialog ? { ...state, dialogOpen: true } : state;
  return page ? (
    <SignalsPageView state={shown} page={page} />
  ) : (
    <>
      <SignalsHomeRailView state={shown} />
      {dialog && <SignalsDialogView state={shown} />}
    </>
  );
}
export default {
  title: "Desktop/Signals/Surfaces",
  component: SignalsHomeRailView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const HomePartialRun = { render: () => <Story /> };
export const FullDialog = { render: () => <Story dialog /> };
export const AlertsAndHistory = { render: () => <Story page="alerts" /> };
export const Watchlist = { render: () => <Story page="watchlist" /> };
export const Journal = { render: () => <Story page="journal" /> };
export const Privacy = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy>
      <Story privacy />
    </UiEnvProvider>
  ),
};
export const Polish = {
  render: () => (
    <UiEnvProvider locale="pl-PL" privacy={false}>
      <Story />
    </UiEnvProvider>
  ),
};
