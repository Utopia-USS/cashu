// Every story of the sync slot renders through the native renderer; the empty slot renders nothing.
import { render, screen } from "@testing-library/react-native";
import { SyncSlotView } from "./SyncSlotView";
import * as stories from "./SyncSlotView.stories";

jest.mock("@expo/ui", () => require("../screens/testing/expoUiMock").default);

const named = Object.entries(stories).filter(
  ([name]) => name !== "default" && name !== "Empty",
) as [string, { args: Parameters<typeof SyncSlotView>[0] }][];

it.each(named)("%s renders", async (_name, story) => {
  await render(<SyncSlotView {...story.args} />);
  expect(screen.toJSON()).not.toBeNull();
});

it("renders nothing for an empty slot", async () => {
  await render(<SyncSlotView {...stories.Empty.args} />);
  expect(screen.toJSON()).toBeNull();
});
