import type { Meta, Story } from "../charts/testing/csf.js";
import { CommandCode, type CommandCodeProps } from "./CopyCommand.js";

const meta = {
  title: "Controls/CommandCode",
  component: CommandCode,
  args: { children: "/market-research rutyna" },
} satisfies Meta<CommandCodeProps>;
export default meta;
export const Default: Story<CommandCodeProps> = {};
export const Wrapped: Story<CommandCodeProps> = {
  args: { children: "~/cashU/demo-anna", wrap: true, surface: "card" },
};
