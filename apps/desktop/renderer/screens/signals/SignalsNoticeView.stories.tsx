import { UiEnvProvider } from "@cashu/ui";
import { SignalsNoticeView } from "./SignalsNoticeView.js";

export default {
  title: "Desktop/Signals/Notice",
  component: SignalsNoticeView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Saved = { render: () => <SignalsNoticeView notice="saved" refusal={null} /> };
export const Removed = { render: () => <SignalsNoticeView notice="removed" refusal={null} /> };
export const Restored = { render: () => <SignalsNoticeView notice="restored" refusal={null} /> };
export const KnownRefusal = {
  render: () => <SignalsNoticeView notice="failed" refusal="undo_expired" />,
};
export const UnknownRefusal = {
  render: () => <SignalsNoticeView notice="failed" refusal="synthetic_refusal" />,
};
