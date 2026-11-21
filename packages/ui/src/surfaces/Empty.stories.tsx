import type { Meta, Story } from "../charts/testing/csf.js";
import { Empty, type EmptyProps } from "./Empty.js";

const meta = {
  title: "Surfaces/Empty",
  component: Empty,
  args: { title: "Brak pozycji.", inWidget: true },
} satisfies Meta<EmptyProps>;
export default meta;
export const Default: Story<EmptyProps> = {};
