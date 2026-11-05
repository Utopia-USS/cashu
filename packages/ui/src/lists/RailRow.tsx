import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { InstTile } from "../instruments/InstTile.js";

/** Text nodes as constants: the DOM-only markup keeps the old text 1:1 (raw JSX text is for <Text>). */
const SP = " ";
const DOT = " · ";

/** One rail row as the model hands it over (the tile's monogram, the bold subject, the muted text and note). */
export interface RailRowData {
  key: string;
  monogram: string;
  /** A subject without an instrument (a portfolio rule): the quiet Σ tile. */
  portfolio?: boolean;
  title: string;
  text?: string | null;
  note?: string | null;
  onOpen?: () => void;
}

/** One rail row (old `.hr-row`): `first` drops the top rule (old `.hgrp .hr-row:first-of-type`). */
export interface RailRowProps {
  row: RailRowData;
  right?: ReactNode;
  first?: boolean;
}

export function RailRow({ row, right, first }: RailRowProps) {
  const { onOpen } = row;
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onOpen && event.target === event.currentTarget && event.key === "Enter") {
      event.preventDefault();
      onOpen();
    }
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest("button")) onOpen?.();
  };
  const link = onOpen
    ? "cursor-pointer rounded-sm hover:bg-subtle focus-visible:outline-2 focus-visible:outline-info focus-visible:-outline-offset-2"
    : "";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a link row (old role=link, Enter opens) holding buttons.
    <div
      role={onOpen ? "link" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? click : undefined}
      onKeyDown={onOpen ? key : undefined}
      className={`flex items-start gap-2.5 py-2 ${first ? "" : "border-t border-border"} ${link}`}
    >
      {/* a flex box, so the tile sits without a line box around it (old `.hr-row > .il` is the tile itself) */}
      <span className="mt-px flex flex-none">
        <InstTile monogram={row.monogram} density="compact" quiet={row.portfolio} />
      </span>
      <span className="min-w-0 flex-1 text-sm leading-cozy">
        <b className="font-heavy">{row.title}</b>
        {row.text ? (
          <>
            {SP}
            <span className="text-fg-muted">{row.text}</span>
          </>
        ) : null}
        {row.note ? (
          <span className="text-xs text-fg-muted">
            {DOT}
            {row.note}
          </span>
        ) : null}
      </span>
      {right != null && <span className="ml-auto flex flex-none items-center gap-1">{right}</span>}
    </div>
  );
}
