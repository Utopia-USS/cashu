import type { Meta, Story } from "../charts/testing/csf.js";
import { CodeLine, type CodeLineProps } from "./CodeLine.js";

const meta = {
  title: "Controls/CodeLine",
  component: CodeLine,
  args: { command: "cashu workspace init", onCopy: () => undefined },
} satisfies Meta<CodeLineProps>;
export default meta;
export const Default: Story<CodeLineProps> = {};
