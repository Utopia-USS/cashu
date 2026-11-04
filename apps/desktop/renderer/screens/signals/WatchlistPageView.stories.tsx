import { UiEnvProvider } from "@cashu/ui";
import { signalsStorySnapshot, storyWatchlist } from "./storyState.js";
import { WatchlistPageView } from "./WatchlistPageView.js";

const data = signalsStorySnapshot();
export default {
  title: "Desktop/Signals/Watchlist page",
  component: WatchlistPageView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Ready = { render: () => <WatchlistPageView {...storyWatchlist(data)} /> };
export const SearchHits = {
  render: () => (
    <WatchlistPageView
      {...storyWatchlist(data, {
        search: {
          text: "SYN",
          hits: [
            {
              key: "local:SYN",
              symbol: "SYN",
              name: "Synthetic instrument",
              state: "watched",
              opens: true,
            },
            {
              key: "yahoo:SYN2",
              symbol: "SYN2",
              name: "Synthetic two",
              state: "new",
              opens: false,
            },
          ],
          searching: false,
          remoteUnavailable: false,
          offerTyped: false,
        },
      })}
    />
  ),
};
export const RemoteUnavailable = {
  render: () => (
    <WatchlistPageView
      {...storyWatchlist(data, {
        search: {
          text: "NEW.WA",
          hits: [],
          searching: false,
          remoteUnavailable: true,
          offerTyped: true,
        },
        canRestore: true,
      })}
    />
  ),
};
export const QuotesUnavailable = {
  render: () => (
    <WatchlistPageView
      {...storyWatchlist({
        ...data,
        context: { status: "unavailable", reason: "market_unavailable" },
      })}
    />
  ),
};
