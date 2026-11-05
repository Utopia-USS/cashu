import { Fragment, type ReactNode } from "react";

export interface TabBarTab {
  id: string;
  label: string;
  /** The open destination: the raised pill, `aria-current="page"`. */
  current: boolean;
  onPress(): void;
  /** A warning dot after the label (old `.dot`: module not set up yet); `pendingTitle` is its tooltip. */
  pending?: boolean;
  pendingTitle?: string;
}

export interface TabBarProps {
  /** Accessible name of the navigation. */
  label: string;
  /** Tab groups in order; a thin separator stands between groups (old `.tabsep` between modules). */
  groups: readonly (readonly TabBarTab[])[];
  /** Right-aligned after a spacer (old tab action, e.g. bank sync). */
  actions?: ReactNode;
  /** Layout only. */
  className?: string;
}

/** The sticky module tab bar under the header (old `nav.tabbar` with `.tabbtn`, `.tabsep`, `.dot`). */
export function TabBar({ label, groups, actions, className = "" }: TabBarProps) {
  return (
    <nav
      aria-label={label}
      className={`sticky top-0 z-20 mb-4.5 flex flex-wrap gap-0.5 border-b border-border bg-surface py-1.5 leading-normal ${className}`}
    >
      {groups.map((tabs, index) => (
        <Fragment key={tabs[0]?.id ?? index}>
          {index > 0 && <span aria-hidden className="m-1.5 w-px self-stretch bg-border" />}
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={tab.current ? "page" : undefined}
              title={tab.pending ? tab.pendingTitle : undefined}
              onClick={tab.onPress}
              className={`cursor-pointer rounded-control border px-3 py-1.5 text-sm-plus font-demi leading-normal ${tab.current ? "border-border bg-surface-raised text-fg shadow-card" : "border-transparent bg-transparent text-fg-muted hover:text-fg"}`}
            >
              {tab.label}
              {tab.pending && (
                <span
                  aria-hidden
                  className="ml-1.5 inline-block size-1.5 rounded-full bg-warning align-middle"
                />
              )}
            </button>
          ))}
        </Fragment>
      ))}
      {actions !== undefined && (
        <>
          <span className="flex-1" />
          {actions}
        </>
      )}
    </nav>
  );
}
