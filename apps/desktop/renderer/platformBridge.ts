// The OS the desktop shell runs on: `process.platform` of the preload, a constant on the bridge (no
// IPC). Copyable commands are rendered for that OS's shell (PowerShell on Windows); the local host
// whose launcher they run is on the same machine.

declare global {
  interface Window {
    readonly cashuPlatform?: unknown;
  }
}

/** `process.platform` of the shell, or undefined outside it (Storybook, tests: POSIX shells). */
export function shellPlatform(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.cashuPlatform;
  return typeof value === "string" && /^[a-z0-9]{1,16}$/.test(value) ? value : undefined;
}
