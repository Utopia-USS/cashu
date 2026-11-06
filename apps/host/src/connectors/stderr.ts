// The stored stderr tail of a connector run (ab24ab6 core/connectors/runner.py `_tail` / `redact`): the owner's view in
// the app, never MCP. Secrets of the run are replaced first (a connector may echo its key), then the strict MCP
// scrubber removes IBANs, long numbers, amounts and e-mails; the tail keeps at most 4 KiB of UTF-8.
import { scrubText } from "@cashu/mcp";

/** Python `STDERR_STORED`: the stored tail in UTF-8 bytes. */
export const STDERR_STORED = 4 * 1024;
/** Python scrubs four times the stored tail, so a secret or number cut at the edge is still caught. */
export const STDERR_KEPT = 4 * STDERR_STORED;

/** `text` with every secret value of the run replaced, the longest first (Python `without_secrets`). */
export function withoutSecrets(
  text: string,
  secrets: Readonly<Record<string, string>> | undefined,
): string {
  const values = Object.values(secrets ?? {})
    .filter((value) => value !== "")
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.replaceAll(value, "[secret]");
  return out;
}

/** The redacted tail of a run's stderr, or null when the process wrote nothing (Python `_tail`). */
export function redactStderrTail(
  raw: Uint8Array,
  secrets: Readonly<Record<string, string>> | undefined,
): string | null {
  if (raw.length === 0) return null;
  // Python decodes the kept bytes with errors="replace": a cut sequence at the start becomes U+FFFD.
  const kept = Buffer.from(raw.subarray(Math.max(0, raw.length - STDERR_KEPT))).toString("utf8");
  const encoded = Buffer.from(scrubText(withoutSecrets(kept, secrets), { strict: true }), "utf8");
  if (encoded.length <= STDERR_STORED) return encoded.toString("utf8");
  // errors="ignore" on the cut: drop the continuation bytes of a split leading character.
  let start = encoded.length - STDERR_STORED;
  while (start < encoded.length && ((encoded[start] as number) & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}
