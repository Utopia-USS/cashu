import type { Meta, Story } from "../charts/testing/csf.js";
import { ClassifyButton, type ClassifyButtonProps } from "./RowMarks.js";

const meta = {
  title: "Instruments/ClassifyButton",
  component: ClassifyButton,
  args: { title: "Classify", label: "Classify ACM", expanded: false, onToggle: () => undefined },
} satisfies Meta<ClassifyButtonProps>;
export default meta;
export const Closed: Story<ClassifyButtonProps> = {};
export const Open: Story<ClassifyButtonProps> = { args: { expanded: true } };
