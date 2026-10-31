import { expect, it } from "vitest";
import { decodeStrict, utf8ErrorReason } from "./codecs.js";

// UnicodeDecodeError.reason of CPython's UTF-8 decoder for each way a sequence can be invalid
// (the full replay is `inv-importing-text`).
it.each([
  [[0x61, 0xff], "invalid start byte"],
  [[0x80], "invalid start byte"],
  [[0xc0, 0xaf], "invalid start byte"],
  [[0xc5], "unexpected end of data"],
  [[0xe2, 0x82], "unexpected end of data"],
  [[0xf0, 0x9f, 0x98], "unexpected end of data"],
  [[0xe2, 0x41], "invalid continuation byte"],
  [[0xe0, 0x80, 0xaf], "invalid continuation byte"],
  [[0xed, 0xa0, 0x80], "invalid continuation byte"],
  [[0xf4, 0x90, 0x80, 0x80], "invalid continuation byte"],
])("%j is %s", (bytes, reason) => {
  const data = Uint8Array.from(bytes);
  const decoded = decodeStrict(data, "utf-8");
  expect(decoded.ok).toBe(false);
  if (!decoded.ok) expect(utf8ErrorReason(data, decoded.start)).toBe(reason);
});
