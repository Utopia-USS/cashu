import type { Meta, Story } from "../charts/testing/csf.js";
import { TickerTile, type TickerTileProps } from "./TickerTile.js";

const meta = {
  title: "Native/TickerTile",
  component: TickerTile,
  args: { ticker: "VWCE" },
} satisfies Meta<TickerTileProps>;
export default meta;
export const Row: Story<TickerTileProps> = {};
export const Risk: Story<TickerTileProps> = { args: { ticker: "CDR", ring: "negative" } };
export const Warning: Story<TickerTileProps> = { args: { ticker: "DBND", ring: "warning" } };
export const Dense: Story<TickerTileProps> = { args: { ticker: "ETFBM40TR" } };
export const Header: Story<TickerTileProps> = {
  args: { ticker: "CDR", size: "header", ring: "negative" },
};
