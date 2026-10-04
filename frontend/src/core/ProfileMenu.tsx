// Profile switcher in the header: ProfilePill + Menu (profiles with a facts line,
// Nowy profil…, Ustawienia profilu). Facts of inactive profiles load when it opens.
import { useEffect, useState } from "react";
import { nAccounts, nModules } from "../format";
import { Menu, MenuHead, MenuItem, MenuSep } from "../ui";
import { getNetworth, type NetworthResp, type Profile } from "./api";

// Avatar colours by profile position (tokens, so both themes work).
const AVATAR = ["var(--nw)", "var(--net)", "var(--nw-property)", "var(--nw-loan)", "var(--nw-vehicle)"];
export const avatarColor = (profiles: Profile[], slug: string) =>
  AVATAR[Math.max(0, profiles.findIndex((p) => p.slug === slug)) % AVATAR.length];

export function Avatar({ name, color }: { name: string; color: string }) {
  return <span className="avatar" style={{ background: color }} aria-hidden>{(name.trim()[0] ?? "?").toUpperCase()}</span>;
}

interface Facts { accounts: number; asof: string | null }
const factsOf = (nw: NetworthResp): Facts => ({
  accounts: nw.accounts.length,
  asof: nw.accounts.map((a) => a.as_of).filter(Boolean).sort().slice(-1)[0] ?? null,
});

export function ProfileMenu({ profiles, active, activeNetworth, onSelect, onNew, onSettings }: {
  profiles: Profile[];
  active: Profile;
  activeNetworth: NetworthResp | null;
  onSelect: (slug: string) => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<Record<string, Facts>>({});
  useEffect(() => setOpen(false), [active.slug]); // switching (also via URL) closes the menu

  useEffect(() => {
    if (!open) return;
    for (const p of profiles) {
      if (p.slug === active.slug || facts[p.slug]) continue;
      getNetworth(p.slug).then((nw) => setFacts((f) => ({ ...f, [p.slug]: factsOf(nw) }))).catch(() => {});
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const line = (p: Profile) => {
    const f = p.slug === active.slug && activeNetworth ? factsOf(activeNetworth) : facts[p.slug];
    const mods = nModules(p.modules.filter((m) => m.enabled).length);
    if (!f) return mods;
    return [nAccounts(f.accounts), mods, f.asof ? `dane do ${f.asof}` : "brak danych"].join(" · ");
  };
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
            title={p.name} sub={line(p)}
            right={p.slug === active.slug && profiles.length > 1 ? <span className="muted" aria-label="aktywny">✓</span> : undefined}
            onSelect={() => { close(); if (p.slug !== active.slug) onSelect(p.slug); }} />
        ))}
        <MenuSep />
        <MenuItem icon={<span className="avatar ghost" aria-hidden>+</span>} title="Nowy profil…" onSelect={() => { close(); onNew(); }} />
        <MenuItem icon={<span className="muted" style={{ width: 22, textAlign: "center" }} aria-hidden>⚙</span>} title="Ustawienia profilu"
          onSelect={() => { close(); onSettings(); }} />
      </Menu>
    </div>
  );
}
