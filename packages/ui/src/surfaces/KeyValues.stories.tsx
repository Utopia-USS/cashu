import type { Meta, Story } from "../charts/testing/csf.js";
import { KeyValues, type KeyValuesProps } from "./KeyValues.js";

const meta = {
  title: "Surfaces/KeyValues",
  component: KeyValues,
  args: {
    rows: [
      { key: "slug", label: "Identifier", value: "synthetic" },
      { key: "version", label: "Version", value: "1.0.0" },
    ],
  },
} satisfies Meta<KeyValuesProps>;
export default meta;
export const Default: Story<KeyValuesProps> = {};
