import type { ReactNode } from "react";

export interface AppHeaderProps {
  /** The wordmark in two cuts: `light` for the light theme (ink letters), `dark` for the dark one. */
  logo: { light: string; dark: string; label: string };
  /** Next to the logo (old `.brand`), e.g. the ProfilePill. */
  brand?: ReactNode;
  /** The right-hand group (old `.hdr-right`), e.g. status tags and an IconToggle. */
  actions?: ReactNode;
  /** Layout only. */
  className?: string;
}

/** The app's top bar (old `header.shell`): logo and profile on the left, quiet controls on the right. */
export function AppHeader({ logo, brand, actions, className = "" }: AppHeaderProps) {
  return (
    <header
      className={`mb-2.5 flex flex-wrap items-center justify-between gap-4 leading-normal ${className}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <h1 className="m-0 flex-none leading-none">
          <img
            className="block h-6.5 w-auto dark:hidden"
            src={logo.light}
            alt={logo.label}
            width={82}
            height={26}
          />
          <img
            className="hidden h-6.5 w-auto dark:block"
            src={logo.dark}
            alt=""
            aria-hidden
            width={82}
            height={26}
          />
        </h1>
        {brand}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </header>
  );
}
