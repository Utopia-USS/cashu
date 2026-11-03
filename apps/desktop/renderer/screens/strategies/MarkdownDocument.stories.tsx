import { MarkdownDocument } from "./MarkdownDocument.js";
import { prose } from "./storyState.js";
export default {
  title: "Desktop/Strategies/Markdown",
  component: MarkdownDocument,
  args: { text: prose },
};
export const Ready = {};
