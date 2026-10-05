// CSV export cells (F7 FE16): formula prefixes neutralised, plain numbers left alone. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, csvLine } from "../src/csv.ts";

test("cells starting with = + - @ tab CR become text; quotes are doubled", () => {
  assert.equal(csvCell('=HYPERLINK("http://x","Kliknij")'), '"\'=HYPERLINK(""http://x"",""Kliknij"")"');
  assert.equal(csvCell("+cmd|' /C calc'!A0"), "\"'+cmd|' /C calc'!A0\"");
  assert.equal(csvCell("-2+3+cmd"), "\"'-2+3+cmd\"");
  assert.equal(csvCell("@SUM(A1)"), "\"'@SUM(A1)\"");
  assert.equal(csvCell("\t=1"), "\"'\t=1\"");
  assert.equal(csvCell("\r=1"), "\"'\r=1\"");
  assert.equal(csvCell("CD Projekt poniżej 140 zł"), '"CD Projekt poniżej 140 zł"');
});

test("plain signed numbers and empty values stay as they are", () => {
  assert.equal(csvCell("-12,3 %"), '"-12,3 %"');
  assert.equal(csvCell("+1,4 %"), '"+1,4 %"');
  assert.equal(csvCell("-"), '"-"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvLine(["a", 1, "=1"]), '"a";"1";"\'=1"');
});
