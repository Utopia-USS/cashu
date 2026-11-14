const decoder = new TextDecoder("utf-8", { fatal: true });
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new Error("native_checkpoint_unavailable");
  }
}
