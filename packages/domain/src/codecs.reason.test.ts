import { expect, it } from "vitest";
import { decodeStrict, utf8ErrorReason } from "./codecs.js";

// The decode error reason a refused import shows (investments/importing/text.ts, pyYaml/scanTags.ts).
it.each([
  [[0x61, 0xff], "invalid start byte"],
  [[0xe2, 0x82], "unexpected end of data"],
  [[0xe2, 0x41], "invalid continuation byte"],
  [[0xed, 0xa0, 0x80], "invalid continuation byte"],
])("%j is %s", (bytes, reason) => {
  const data = Uint8Array.from(bytes);
  const decoded = decodeStrict(data, "utf-8");
  expect(decoded.ok).toBe(false);
  if (!decoded.ok) expect(utf8ErrorReason(data, decoded.start)).toBe(reason);
});
