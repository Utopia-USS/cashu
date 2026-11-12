// The phone's line icons: 24-unit paths drawn with a 1.5 stroke, round caps and joins, in the text colour
// of the Uniwind class the caller passes (the prototype's `.ic`, design/mobile/companion/prototype.html).
import { Path, Svg } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

const PATHS = {
  eye: [
    "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z",
    "M9.2 12a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0-5.6 0",
  ],
  "eye-off": [
    "M2.5 12s3.5-6.5 9.5-6.5c1.6 0 3 .4 4.2 1M21.5 12s-1.2 2.3-3.6 4.1M9.8 18.2c.7.2 1.4.3 2.2.3",
    "M4 4l16 16",
  ],
  plus: ["M12 5v14M5 12h14"],
  "chevron-left": ["M15 5l-7 7 7 7"],
  "chevron-right": ["m9 6 6 6-6 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  x: ["M6 6l12 12M18 6 6 18"],
  backspace: [
    "M9 5.5h10A1.5 1.5 0 0 1 20.5 7v10a1.5 1.5 0 0 1-1.5 1.5H9L3.5 12z",
    "m11.5 9.5 5 5M16.5 9.5l-5 5",
  ],
  bell: ["M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0"],
  tag: [
    "M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9-8-8z",
    "M7.1 8.5a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0",
  ],
  calendar: [
    "M6.5 5h11A2.5 2.5 0 0 1 20 7.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5z",
    "M4 10h16M9 3v4M15 3v4",
  ],
  laptop: [
    "M6 5h12a1.5 1.5 0 0 1 1.5 1.5V14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 14V6.5A1.5 1.5 0 0 1 6 5z",
    "M2.5 19h19",
  ],
  shield: ["M12 3 5 6v5.5c0 4.3 3 7.7 7 9.5 4-1.8 7-5.2 7-9.5V6z"],
  search: ["M4.5 11a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0", "m16 16 4.5 4.5"],
  sync: [
    "M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5",
  ],
  doc: ["M6 3.5h8l4 4v13H6z", "M14 3.5v4h4M9 12h6M9 16h6"],
  wallet: [
    "M5.5 7h13A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-8A2.5 2.5 0 0 1 5.5 7z",
    "M6 7l10-3 1 3M16.5 13.5h1.5",
  ],
  chart: ["M4 4v15.5h16", "m7.5 14.5 4-4.5 3 3 5-6"],
  home: ["M4 10.5 12 4l8 6.5V20H4z", "M10 20v-5h4v5"],
  activity: ["M4 6h16M4 12h16M4 18h10"],
  card: [
    "M5.5 5.5h13A2.5 2.5 0 0 1 21 8v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16V8a2.5 2.5 0 0 1 2.5-2.5z",
    "M3 10h18M7 14.5h3",
  ],
  sparkle: ["M12 4c.7 4.2 3.8 7.3 8 8-4.2.7-7.3 3.8-8 8-.7-4.2-3.8-7.3-8-8 4.2-.7 7.3-3.8 8-8z"],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof PATHS;

/** Every icon name, in drawing order (the story grid). */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps {
  name: IconName;
  /** Box size in points (default 16, the size beside a caption). */
  size?: 16 | 20 | 24;
  /** The text colour role of the stroke (default `text-fg`), e.g. `text-fg-muted`. */
  className?: string;
}

/** A decorative line icon: the label or the control beside it names it for assistive technology. */
export function Icon({ name, size = 16, className = "text-fg" }: IconProps) {
  const { color } = useResolveClassNames(className);
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      color={color == null ? undefined : String(color)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {PATHS[name].map((d) => (
        <Path
          key={d}
          d={d}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
