import type { Meta, Story } from "../charts/testing/csf.js";
import { RadioList, type RadioListProps } from "./RadioList.js";

const meta = {
  title: "Controls/RadioList",
  component: RadioList,
  args: {
    name: "mode",
    value: "file",
    onChange: () => undefined,
    options: [
      { value: "file", title: "File", desc: "Import an export" },
      { value: "fetch", title: "Fetch", desc: "Pull from an API" },
    ],
  },
} satisfies Meta<RadioListProps<string>>;
export default meta;
export const Default: Story<RadioListProps<string>> = {};
export const NothingPicked: Story<RadioListProps<string>> = { args: { value: null } };
