import type { CSSProperties, ReactNode } from "react";

export type InstDensity = "row" | "compact" | "header";
/** Thesis health ring: supports (accent), fulfilled (violet), weakened (warning), invalidated (dashed). */
export type InstHealth = "sup" | "ful" | "weak" | "inv";

// The ticker tile (old `.il .av` per density, `.il .avw .pl` plan coin). Black with light grey type in both
// themes; a 5-character monogram (or 4 capitals with two or more W / M) steps the type down.
const tiles = {
  row: { box: "h-6.5 w-10 rounded-sm", type: "text-3xs-plus", dense: "text-4xs" },
  compact: { box: "h-5.5 w-9 rounded-xs", type: "text-4xs-plus", dense: "text-5xs" },
  header: { box: "h-8.5 w-13 rounded-sm-plus", type: "text-sm", dense: "text-2xs-plus" },
} as const;
const coins = {
  row: "-top-[5.5px] -right-[5.5px] size-3.25 p-[1.5px]",
  compact: "-top-1.5 -right-1.5 size-3 p-px",
  header: "-top-[5.5px] -right-[5.5px] size-4 p-0.5",
} as const;
const gaps = { row: "gap-2.5", compact: "gap-2", header: "gap-3" } as const;
// The surface the tile sits on (rim and ring gap colour): a hovered row sets `--tile-bg` on an ancestor.
const tileBg = "var(--tile-bg, var(--color-surface-raised))";
const ringHue = {
  sup: "var(--color-accent)",
  ful: "var(--color-net)",
  weak: "var(--color-warning)",
} as const;

function isDense(monogram: string): boolean {
  return (
    monogram.length >= 5 || (monogram.length === 4 && (monogram.match(/[WM]/g) ?? []).length >= 2)
  );
}

function ringStyle(
  health: InstHealth | null | undefined,
  faded: boolean,
): CSSProperties | undefined {
  if (!health) return undefined;
  if (health === "inv")
    return {
      outline: `1.5px dashed ${faded ? `color-mix(in srgb, var(--color-warning) 50%, ${tileBg})` : "var(--color-warning)"}`,
      outlineOffset: 1,
    };
  const hue = faded ? `color-mix(in srgb, ${ringHue[health]} 50%, ${tileBg})` : ringHue[health];
  return { boxShadow: `0 0 0 1px ${tileBg}, 0 0 0 2.5px ${hue}` };
}

export interface PlanGlyphProps {
  /** The plan's chevron path (12 x 12 view box); null draws the dashed empty coin. */
  path: string | null;
  /** Layout only. */
  className?: string;
}

/** The recommendation coin on its own (old `.pcoin`, 16px): light chevrons on the coin fill. */
export function PlanGlyph({ path, className = "" }: PlanGlyphProps) {
  if (path == null)
    return (
      <span
        aria-hidden="true"
        className={`inline-block size-4 flex-none rounded-full border border-dashed border-fg-muted ${className}`}
      />
    );
  return (
    <ChevronSvg
      path={path}
      className={`inline-block size-4 flex-none rounded-full bg-av-coin p-0.5 text-av-fg ${className}`}
    />
  );
}

function ChevronSvg({ path, className }: { path: string; className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export interface InstTileProps {
  /** The ticker monogram (4 capitals fit; 5 characters step the type down). */
  monogram: string;
  density?: InstDensity;
  /** The recommendation as a coin on the top-right corner: its chevron path. */
  plan?: string | null;
  /** Rim colour of the plan coin: `maybe` (warning) or `out` (negative) freshness; default the surface. */
  freshness?: "maybe" | "out" | null;
  /** Thesis health ring around the tile. */
  health?: InstHealth | null;
  /** The ring rests on research older than the thesis: faded to 50 %. */
  faded?: boolean;
  /** Quiet tile (chip fill, muted 12px type) for a non-instrument subject such as the whole portfolio. */
  quiet?: boolean;
}

/** The tile with its wrapper only (old `<span class="il cmp"><InstTile/></span>`); `InstLabel` adds the name. */
export function InstTile(props: InstTileProps) {
  const density = props.density ?? "row";
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center align-middle ${gaps[density]}`}>
      <TileFace {...props} />
    </span>
  );
}

function TileFace({
  monogram,
  density = "row",
  plan,
  freshness,
  health,
  faded = false,
  quiet,
}: InstTileProps) {
  const tile = tiles[density];
  const dense = isDense(monogram);
  const face = quiet
    ? "bg-chip text-xs tracking-snug text-fg-muted"
    : `bg-av-bg text-av-fg ${dense ? `${tile.dense} tracking-dense` : `${tile.type} tracking-snug`}`;
  const rim =
    freshness === "maybe"
      ? "var(--color-warning)"
      : freshness === "out"
        ? "var(--color-negative)"
        : tileBg;
  return (
    <span className="relative inline-flex flex-none">
      <span
        aria-hidden="true"
        className={`inline-flex flex-none select-none items-center justify-center overflow-hidden whitespace-nowrap border-0 font-heavy leading-none tabular-nums ${tile.box} ${face}`}
        style={ringStyle(health, faded)}
      >
        {monogram}
      </span>
      {plan && (
        <span
          className={`pointer-events-none absolute block rounded-full bg-av-coin text-av-fg ${coins[density]}`}
          style={{ boxShadow: `0 0 0 1.5px ${rim}` }}
        >
          <ChevronSvg path={plan} className="block size-full" />
        </span>
      )}
    </span>
  );
}

export interface InstLabelProps extends InstTileProps {
  /** The instrument's name (or a display text such as a signal title). */
  name: ReactNode;
  /** Set: the name is a button that opens the instrument; unset: plain text. */
  onOpen?: () => void;
  /** Status markers right after the name (flags, agent badge). */
  badges?: ReactNode;
  /** After the badges (e.g. a classify button). */
  action?: ReactNode;
  /** Muted second line (row, compact) or the muted text after the name (header). */
  sub?: ReactNode;
  /** One-line tooltip of the whole label. */
  title?: string;
  /** `header` density inside a heading (old `.ahead .nm .il`): the name takes the heading's size and weight,
   * the muted text after it 13px 500 with a 3px gap. */
  heading?: boolean;
}

/** Instrument identity: ticker tile + name (+ second line), old `.il` / `.il.cmp` / `.il.hd`. The hover card
 * of the old app is not part of it (compose one around the label where needed). */
export function InstLabel({
  name,
  onOpen,
  badges,
  action,
  sub,
  title,
  heading,
  ...tile
}: InstLabelProps) {
  const density = tile.density ?? "row";
  const hasSub = sub != null && sub !== "";
  const nameNode = onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className="min-w-0 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent p-0 text-left font-strong text-fg hover:text-accent"
    >
      {name}
    </button>
  ) : (
    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
  );
  const subLine = hasSub && (
    <span
      className={`overflow-hidden text-ellipsis whitespace-nowrap leading-dense text-fg-muted ${heading ? "ml-0.75 text-sm font-medium" : `text-2xs-plus font-regular ${density === "header" ? "" : "mt-0.5"}`}`}
    >
      {sub}
    </span>
  );
  return (
    <span
      title={title}
      className={`inline-flex min-w-0 max-w-full items-center align-middle ${gaps[density]}`}
    >
      <TileFace {...tile} />
      <span className="flex min-w-0 flex-col justify-center">
        <span
          className={`flex min-w-0 items-center gap-1.25 leading-tight ${heading ? "[font-size:inherit] [font-weight:inherit]" : "font-strong text-sm"}`}
        >
          {nameNode}
          {badges}
          {action}
          {density === "header" && subLine}
        </span>
        {density !== "header" && subLine}
      </span>
    </span>
  );
}
