// Profile switcher in the header: ProfilePill + Menu (profiles, Nowy profil…, Ustawienia).
import { useEffect, useState } from "react";
import { Menu, MenuHead, MenuItem, MenuSep } from "../ui";
import type { Profile } from "./api";

// Avatar colours by profile position (tokens, so both themes work).
const AVATAR = ["var(--nw)", "var(--net)", "var(--nw-property)", "var(--nw-loan)", "var(--nw-vehicle)"];
export const avatarColor = (profiles: Profile[], slug: string) =>
  AVATAR[Math.max(0, profiles.findIndex((p) => p.slug === slug)) % AVATAR.length];

export function Avatar({ name, color }: { name: string; color: string }) {
  return <span className="avatar" style={{ background: color }} aria-hidden>{(name.trim()[0] ?? "?").toUpperCase()}</span>;
}

export function ProfileMenu({ profiles, active, onSelect, onNew, onSettings }: {
  profiles: Profile[];
  active: Profile;
  onSelect: (slug: string) => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [active.slug]); // switching (also via URL) closes the menu

  const close = () => setOpen(false);

  return (
    <div className="menu-anchor">
      <button className={`btn pill ${open ? "open" : ""}`} aria-haspopup="menu" aria-expanded={open}
        title="Profil" onClick={() => setOpen((o) => !o)}>
        <Avatar name={active.name} color={avatarColor(profiles, active.slug)} />
        {active.name} <span className="muted" style={{ fontSize: 11 }}>{open ? "▴" : "▾"}</span>
      </button>
      <Menu open={open} onClose={close} label="Profile">
        <MenuHead>Profile</MenuHead>
        {profiles.map((p) => (
          <MenuItem key={p.slug} on={p.slug === active.slug}
            icon={<Avatar name={p.name} color={avatarColor(profiles, p.slug)} />}
            title={p.name}
            right={p.slug === active.slug && profiles.length > 1 ? <span className="muted" aria-label="aktywny">✓</span> : undefined}
            onSelect={() => { close(); if (p.slug !== active.slug) onSelect(p.slug); }} />
        ))}
        <MenuSep />
        <MenuItem icon={<span className="avatar ghost" aria-hidden>+</span>} title="Nowy profil…" onSelect={() => { close(); onNew(); }} />
        <MenuItem icon={<span className="muted" style={{ width: 22, textAlign: "center" }} aria-hidden>⚙</span>} title="Ustawienia"
          onSelect={() => { close(); onSettings(); }} />
      </Menu>
    </div>
  );
}
