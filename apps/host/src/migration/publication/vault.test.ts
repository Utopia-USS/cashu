import { DEFAULT_MAX_FRAME_BYTES, FRAME_FORMAT } from "@cashu/sync";
import { expect, it } from "vitest";
import { chunkGenesisEvents } from "./vault.js";

it("keeps non-ASCII genesis payloads inside one UTF-8 frame each", () => {
  type Event = Parameters<typeof chunkGenesisEvents>[0][number];
  const event = { h: "0".repeat(47), note: "ą".repeat(300_000) } as unknown as Event;
  const chunks = chunkGenesisEvents([event, event]);
  expect(chunks).toHaveLength(2);
  for (const chunk of chunks)
    expect(Buffer.byteLength(JSON.stringify({ f: FRAME_FORMAT, e: chunk }))).toBeLessThanOrEqual(
      DEFAULT_MAX_FRAME_BYTES,
    );
  const oversized = { h: "0".repeat(47), note: "ą".repeat(600_000) } as unknown as Event;
  expect(() => chunkGenesisEvents([oversized])).toThrow("replay_mismatch");
});
