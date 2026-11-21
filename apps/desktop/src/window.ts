import { DEFAULT_SIZE, MIN_SIZE, SCREEN_MARGIN } from "./config.js";

export interface ScreenSize {
  width: number;
  height: number;
}

/** The default size, shrunk to the main screen (never below the minimum size). */
export function windowSize(screens?: readonly ScreenSize[]): { width: number; height: number } {
  let { width, height } = DEFAULT_SIZE as { width: number; height: number };
  const screen = screens?.[0];
  if (screen) {
    width = Math.min(width, Math.trunc(screen.width) - SCREEN_MARGIN);
    height = Math.min(height, Math.trunc(screen.height) - SCREEN_MARGIN);
  }
  return { width: Math.max(width, MIN_SIZE.width), height: Math.max(height, MIN_SIZE.height) };
}
