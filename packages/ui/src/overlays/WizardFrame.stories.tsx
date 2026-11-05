import type { Meta, Story } from "../charts/testing/csf.js";
import { WizardFrame, type WizardFrameProps } from "./WizardFrame.js";

const meta = {
  title: "Overlays/WizardFrame",
  component: WizardFrame,
  args: {
    mode: "page",
    label: "Nowy profil",
    title: "Witaj w cashU",
    steps: ["Profil", "Moduły", "Prywatność"],
    current: 0,
    children: null,
  },
} satisfies Meta<WizardFrameProps>;
export default meta;
export const Default: Story<WizardFrameProps> = {};
