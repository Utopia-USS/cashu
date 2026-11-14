import type { Meta, Story } from "../charts/testing/csf.js";
import { CopyCommand, type CopyCommandProps } from "./CopyCommand.js";

const meta = {
  title: "Controls/CopyCommand",
  component: CopyCommand,
  args: { command: "cd ~/cashU/demo && claude", label: "Copy command", onCopy: () => {} },
} satisfies Meta<CopyCommandProps>;
export default meta;
export const Default: Story<CopyCommandProps> = {};
export const ButtonOnly: Story<CopyCommandProps> = {
  args: { primary: false, showCommand: false, size: "sm" },
};
