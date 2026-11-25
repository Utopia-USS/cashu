// Windows path facts every Node process of cashU needs on its own (the `cashu` shim, the Electron
// main process), kept pure so they hold on any OS: the CLI and desktop tests run them on macOS and
// Linux with an injected platform. Resolution against the disk stays with each caller.

/** A fully qualified Windows path: `C:\...` (either separator) or a UNC path `\\server\share\...`. */
export function winIsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/** DOS device names, which Windows opens as a device in any folder and with any extension. */
const DOS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i;

/**
 * A path naming a file on a drive letter, checked as text before any file-system call: what a path
 * an agent or another process supplies must be on Windows before cashU resolves, stats or opens it.
 * Refused: UNC paths (`\\server\share\...`, `//server/share/...`: touching one makes Windows open an
 * SMB connection to that server and authenticate with the user's NTLM credentials), device and
 * namespace paths (`\\?\...`, `\\.\...`, `\??\...`), rooted (`\x`) and drive-relative (`C:x`) paths,
 * an NTFS stream (a `:` past the drive), a NUL, and DOS device names in any segment (`NUL`,
 * `COM1.csv`). A mapped network drive passes this text check (Windows reaches it over the session the
 * user opened); a caller that wants local files only also checks the resolved path, which Windows
 * reports as UNC for such a drive.
 */
export function isLocalDrivePath(path: string): boolean {
  if (!/^[A-Za-z]:[\\/]/.test(path) || path.includes("\0") || path.indexOf(":", 2) !== -1)
    return false;
  return path
    .slice(3)
    .split(/[\\/]/)
    .every((segment) => !DOS_DEVICE.test(segment.split(".")[0]?.trimEnd() ?? ""));
}
