import { type ReactNode, useEffect, useRef, useState } from "react";

export interface ProfilePillProfile {
  id: string;
  name: string;
}

export interface ProfilePillAction {
  id: string;
  label: string;
  /** `add`: the dashed ghost avatar with a plus (old new-profile row); `settings`: the gear. */
  glyph: "add" | "settings";
  onPress(): void;
}

export interface ProfilePillProps {
  profiles: readonly ProfilePillProfile[];
  activeId: string;
  onSelect(id: string): void;
  /** Rows under the profile list (new profile, settings). */
  actions?: readonly ProfilePillAction[];
  /** Tooltip of the pill (old title "Profil"). */
  title: string;
  /** Heading and accessible name of the menu (old "Profile"). */
  menuLabel: string;
  /** The pill cannot open (e.g. while a switch is in flight). */
  disabled?: boolean;
}

// Avatar fills by profile position (old ProfileMenu AVATAR: --nw, --net, --nw-property, --nw-loan,
// --nw-vehicle).
const AVATAR = ["bg-accent", "bg-net", "bg-nw-property", "bg-nw-loan", "bg-nw-vehicle"] as const;

function avatarFill(profiles: readonly ProfilePillProfile[], id: string): string {
  const index = Math.max(
    0,
    profiles.findIndex((profile) => profile.id === id),
  );
  return AVATAR[index % AVATAR.length] ?? AVATAR[0];
}

// The old menu's glyphs (not words, so no catalog).
const MARK = { add: "+", settings: "⚙", check: "✓" } as const;

const avatarShape =
  "inline-flex flex-none items-center justify-center rounded-full font-bold text-on-accent";

function Avatar({ name, fill, small }: { name: string; fill: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={`${avatarShape} ${fill} ${small ? "size-5 text-3xs-plus" : "size-5.5 text-2xs"}`}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

const itemLook =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-sm border-none px-2.5 py-2 text-left text-md text-fg leading-normal font-regular hover:bg-chip focus-visible:bg-chip focus-visible:outline-none";

function MenuRow({
  role,
  checked,
  icon,
  label,
  right,
  onPress,
}: {
  role: "menuitem" | "menuitemradio";
  checked?: boolean;
  icon: ReactNode;
  label: string;
  right?: ReactNode;
  onPress(): void;
}) {
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1">{label}</span>
      {right}
    </>
  );
  if (role === "menuitemradio")
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={checked === true}
        data-menu-item=""
        data-on={checked ? "" : undefined}
        onClick={onPress}
        className={`${itemLook} ${checked ? "bg-chip" : "bg-transparent"}`}
      >
        {body}
      </button>
    );
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item=""
      onClick={onPress}
      className={`${itemLook} bg-transparent`}
    >
      {body}
    </button>
  );
}

function ActionGlyph({ glyph }: { glyph: ProfilePillAction["glyph"] }) {
  if (glyph === "add")
    return (
      <span
        aria-hidden
        className="inline-flex size-5.5 flex-none items-center justify-center rounded-full border border-dashed border-fg-muted bg-chip text-2xs font-bold text-fg-muted"
      >
        {MARK.add}
      </span>
    );
  return (
    <span aria-hidden className="w-5.5 flex-none text-center text-fg-muted">
      {MARK.settings}
    </span>
  );
}

/**
 * The header's profile switcher (old ProfileMenu: `.btn.pill` + `.menu`): the active profile's avatar
 * and name in a round pill; it opens a popover with every profile and the extra actions. Closes on
 * Esc, an outside click and a pick; arrow keys move between rows.
 */
export function ProfilePill({
  profiles,
  activeId,
  onSelect,
  actions = [],
  title,
  menuLabel,
  disabled,
}: ProfilePillProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const active = profiles.find((profile) => profile.id === activeId) ?? profiles[0];

  useEffect(() => {
    if (!open) return;
    const node = menu.current;
    (
      node?.querySelector<HTMLElement>("[data-menu-item][data-on]") ??
      node?.querySelector<HTMLElement>("[data-menu-item]")
    )?.focus();
    const onDown = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        pill.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...(node?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "ArrowDown"
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (active === undefined) return null;
  return (
    <div ref={anchor} className="relative">
      <button
        ref={pill}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        className={`inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border bg-surface-raised py-0.75 pr-2.5 pl-0.75 text-sm text-fg leading-cozy font-regular disabled:cursor-default disabled:opacity-60 ${open ? "border-accent" : "border-border"}`}
      >
        <Avatar name={active.name} fill={avatarFill(profiles, active.id)} small />
        {active.name}
        <span aria-hidden className="text-2xs text-fg-muted">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={menuLabel}
          className="absolute top-full left-0 z-50 mt-1.5 min-w-75 rounded-md border border-border bg-surface-raised p-1.5 text-base leading-normal shadow-toast"
        >
          <div className="px-2.5 pt-1.5 pb-0.5 text-2xs uppercase tracking-caps text-fg-muted">
            {menuLabel}
          </div>
          {profiles.map((profile) => {
            const on = profile.id === active.id;
            return (
              <MenuRow
                key={profile.id}
                role="menuitemradio"
                checked={on}
                icon={<Avatar name={profile.name} fill={avatarFill(profiles, profile.id)} />}
                label={profile.name}
                right={
                  on && profiles.length > 1 ? (
                    // The row's aria-checked says it; the mark is the visual of the old row.
                    <span aria-hidden className="text-fg-muted">
                      {MARK.check}
                    </span>
                  ) : undefined
                }
                onPress={() => {
                  setOpen(false);
                  if (!on) onSelect(profile.id);
                }}
              />
            );
          })}
          {actions.length > 0 && <hr className="my-1.5 h-px border-0 bg-border" />}
          {actions.map((action) => (
            <MenuRow
              key={action.id}
              role="menuitem"
              icon={<ActionGlyph glyph={action.glyph} />}
              label={action.label}
              onPress={() => {
                setOpen(false);
                action.onPress();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
