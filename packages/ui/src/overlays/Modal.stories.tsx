import type { Meta, Story } from "../charts/testing/csf.js";
import { Button } from "../controls/Button.js";
import { Modal } from "./Modal.js";
import type { ModalProps } from "./Modal.types.js";

const closeLabel = "Close";
const heading = "Details";
const hint = "Fill in every field.";
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
export const LabelledByHeading: Story<ModalProps> = {
  args: {
    labelledBy: "modal-story-heading",
    children: (
      <>
        <h2 id="modal-story-heading">{heading}</h2>
        <Button>{closeLabel}</Button>
      </>
    ),
  },
};
export const Center: Story<ModalProps> = { args: { placement: "center" } };
export const CenterNarrow: Story<ModalProps> = { args: { placement: "center", width: "sm" } };
export const CenterWide: Story<ModalProps> = { args: { placement: "center", width: "2xl" } };
export const DescribedForm: Story<ModalProps> = {
  args: {
    placement: "center",
    width: "sm",
    closeOnBackdrop: false,
    describedBy: "modal-story-hint",
    children: (
      <>
        <p id="modal-story-hint">{hint}</p>
        <Button>{closeLabel}</Button>
      </>
    ),
  },
};
export const EndDrawer: Story<ModalProps> = { args: { placement: "end" } };
export const Screen: Story<ModalProps> = { args: { placement: "screen" } };
