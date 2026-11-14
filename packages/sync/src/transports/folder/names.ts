// File names in a synced vault folder: `<vault>/<device>/<seq>.seg`, `<seq>` zero-padded to 6 digits.
//
// Sync tools add their own files next to ours; we recognise them by name and never write them:
// - conflict copies of a segment, named from the original: `000003 (1).seg` (Windows, Google Drive),
//   `000003 2.seg` (iCloud Drive), `000003.sync-conflict-20261031-120000-ABCDEFG.seg` (Syncthing),
//   `000003 (conflicted copy 2026-10-31).seg` (Dropbox), `000003-HOSTNAME.seg` (OneDrive). Rule: the
//   digits of the sequence number, then a separator (space . - _ or parenthesis), anything, `.seg`.
// - iCloud placeholders of evicted files: `.000003.seg.icloud` (the bytes are not on this machine).
// - temporary files: any dot-file, ours (`.000003.seg.<token>.tmp`) and the tools' (`.syncthing.*.tmp`).

const SEG_DIGITS = 6;
const CANONICAL = /^(\d{1,10})\.seg$/;
const COPY = /^(\d{1,10})[ ._()-].*\.seg$/;
const PLACEHOLDER = /^\.(\d{1,10})(?:[ ._()-].*)?\.seg\.icloud$/;
const OWN_TEMP = /^\.(\d{1,10})\.seg\.[0-9a-z]+\.tmp$/;

export type SegmentName =
  /** The segment file itself (exactly the canonical spelling). */
  | { readonly kind: "canonical"; readonly seg: number }
  /** Another version of the segment: a conflict copy, or a non-canonical spelling of the number. */
  | { readonly kind: "copy"; readonly seg: number }
  /** iCloud placeholder: the segment exists but is not downloaded. */
  | { readonly kind: "evicted"; readonly seg: number }
  /** One of our temporary files (left over by a crash when found later). */
  | { readonly kind: "temp"; readonly seg: number };

export function segmentFileName(seg: number): string {
  return `${String(seg).padStart(SEG_DIGITS, "0")}.seg`;
}

export function tempFileName(seg: number, token: string): string {
  return `.${segmentFileName(seg)}.${token}.tmp`;
}

/** Classify a file name in a device directory; `undefined` = not ours, ignore it. */
export function parseSegmentName(name: string): SegmentName | undefined {
  const placeholder = PLACEHOLDER.exec(name);
  if (placeholder) return { kind: "evicted", seg: Number(placeholder[1]) };
  const temp = OWN_TEMP.exec(name);
  if (temp) return { kind: "temp", seg: Number(temp[1]) };
  if (name.startsWith(".")) return undefined;
  const canonical = CANONICAL.exec(name);
  if (canonical) {
    const seg = Number(canonical[1]);
    return name === segmentFileName(seg) ? { kind: "canonical", seg } : { kind: "copy", seg };
  }
  const copy = COPY.exec(name);
  if (copy) return { kind: "copy", seg: Number(copy[1]) };
  return undefined;
}
