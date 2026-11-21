import { Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import type { Decorator, Meta, Story } from "../charts/testing/csf.js";
import { SwipeStack, type SwipeStackProps } from "./SwipeStack.js";

function StoryCard({ title, caption }: { title: string; caption: string }) {
  return (
    <View className="flex-1 gap-1 rounded-widget border border-border bg-surface-raised p-5">
      <Text className="text-caption text-fg-muted">{caption}</Text>
      <Text className="text-headline font-strong text-fg">{title}</Text>
    </View>
  );
}

/** Gestures need the handler's root; the app wraps its own root, a story wraps itself. */
const gestureRoot: Decorator = (Inner) => (
  <GestureHandlerRootView>
    <Inner />
  </GestureHandlerRootView>
);

const meta = {
  title: "Native/SwipeStack",
  component: SwipeStack,
  decorators: [gestureRoot],
  args: {
    children: <StoryCard title="Farmers market" caption="12 Nov · Everyday account" />,
    behind: <StoryCard title="Insurance" caption="11 Nov · Everyday account" />,
    onSwiped: () => {},
    swipeLeftLabel: "Come back to this",
    swipeRightLabel: "Next",
  },
} satisfies Meta<SwipeStackProps>;
export default meta;
export const WithNext: Story<SwipeStackProps> = {};
export const LastCard: Story<SwipeStackProps> = { args: { behind: undefined } };
export const Disabled: Story<SwipeStackProps> = { args: { enabled: false } };
export const Short: Story<SwipeStackProps> = { args: { height: 200 } };
