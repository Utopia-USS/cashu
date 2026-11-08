import { MarkdownDocument } from "./MarkdownDocument.js";
import { prose } from "./testing/storyState.js";
export default {
  title: "Desktop/Strategies/Markdown",
  component: MarkdownDocument,
  args: { text: prose },
};
export const Ready = {};
