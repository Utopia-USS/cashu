import type { Meta, Story } from "../charts/testing/csf.js";
import { Dialog, type DialogProps } from "./Dialog.js";

const meta = {
  title: "Overlays/Dialog",
  component: Dialog,
  args: {
    title: "Signals",
    label: "Signals",
    onClose: () => {},
    children: "Two open signals.",
    footer: "Journal",
  },
} satisfies Meta<DialogProps>;
export default meta;
export const Default: Story<DialogProps> = {};
export const Narrow: Story<DialogProps> = { args: { size: "narrow", footer: undefined } };
