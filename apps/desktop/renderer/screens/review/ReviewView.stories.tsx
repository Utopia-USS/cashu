import type { views } from "@cashu/domain/investments";
import { UiEnvProvider } from "@cashu/ui";
import { ReviewView } from "./ReviewView.js";
import { useStoryState } from "./storyState.js";

function Story({
  card = "world",
  long = false,
  availability,
}: {
  card?: views.ReviewCardId | "summary";
  long?: boolean;
  availability?: "empty" | "unavailable" | "error";
}) {
  return <ReviewView state={useStoryState(card, long, availability)} />;
}
export default {
  title: "Desktop/Review/Deck",
  component: ReviewView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const World = { render: () => <Story /> };
export const Sectors = { render: () => <Story card="sectors" /> };
export const Positions = { render: () => <Story card="positions" /> };
export const Events = { render: () => <Story card="events" /> };
export const Ideas = { render: () => <Story card="ideas" /> };
export const Calendar = { render: () => <Story card="calendar" /> };
export const EmptyCalendar = { render: () => <Story card="calendar" availability="empty" /> };
export const UnavailableCalendar = {
  render: () => <Story card="calendar" availability="unavailable" />,
};
export const CalendarError = { render: () => <Story card="calendar" availability="error" /> };
export const Decide = { render: () => <Story card="decide" /> };
export const Summary = { render: () => <Story card="summary" /> };
export const LongDetails = { render: () => <Story card="positions" long /> };
export const Polish = {
  render: () => (
    <UiEnvProvider locale="pl-PL" privacy={false}>
      <Story />
    </UiEnvProvider>
  ),
};
export const Privacy = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy>
      <Story />
    </UiEnvProvider>
  ),
};
