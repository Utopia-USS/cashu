import type { Meta, Story } from "../charts/testing/csf.js";
import { ProfilePill, type ProfilePillProps } from "./ProfilePill.js";

const meta = {
  title: "Shell/ProfilePill",
  component: ProfilePill,
  args: {
    profiles: [
      { id: "a", name: "Synthetic Anna" },
      { id: "b", name: "Synthetic Piotr" },
    ],
    activeId: "a",
    onSelect: () => {},
    actions: [
      { id: "new", label: "New profile…", glyph: "add", onPress: () => {} },
      { id: "settings", label: "Settings", glyph: "settings", onPress: () => {} },
    ],
    title: "Profile",
    menuLabel: "Profiles",
  },
} satisfies Meta<ProfilePillProps>;
export default meta;
export const Default: Story<ProfilePillProps> = {};
