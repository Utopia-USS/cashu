import type { Meta, Story } from "../charts/testing/csf.js";
import { Button } from "../controls/Button.js";
import { Modal } from "./Modal.js";
import type { ModalProps } from "./Modal.types.js";

const closeLabel = "Close";
const meta = {
  title: "Overlays/Modal",
  component: Modal,
  args: {
    label: "Details",
    onClose: () => {},
    children: <Button>{closeLabel}</Button>,
  },
} satisfies Meta<ModalProps>;
export default meta;
export const Default: Story<ModalProps> = {};
export const PanelFocus: Story<ModalProps> = { args: { focus: "panel" } };
