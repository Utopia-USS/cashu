// Expected tails come from the frozen Python oracle (parity/python/oracle `runner._tail`) on these synthetic inputs.
import { expect, it } from "vitest";
import { redactStderrTail, STDERR_STORED, withoutSecrets } from "./stderr.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const polish = "zażółć gęślą jaźń ";

it("redacts a stderr tail exactly like Python", () => {
  const vectors: [string, Record<string, string>, string | null][] = [
    [
      'Traceback (most recent call last):\n  File "main.py", line 3\nValueError: token sk-synthetic-123 rejected\n',
      { token: "sk-synthetic-123" },
      'Traceback (most recent call last):\n  File "main.py", line 3\nValueError: token [secret] rejected\n',
    ],
    [
      "auth failed for api key abcdefSYNTH\nretry in 30 s\n",
      { key: "abcdefSYNTH", other: "abc" },
      "auth failed for api key [secret]\nretry in [amount] s\n",
    ],
    [
      "balance 1 234,56 PLN on PL61109010140000071219812874 sent to jan@example.com\n",
      {},
      "balance [amount] on [iban] sent to [email]\n",
    ],
    [
      "account 12345678901234 amount 99.95 EUR on 2026-10-31, ref 2026-11-01T10:00:00Z\n",
      {},
      "account [number] amount [amount] on 2026-10-31, ref 2026-11-01T10:00:00Z\n",
    ],
    [
      `${"x".repeat(5000)}\nend 1500,00 zł\n`,
      {},
      `${"x".repeat(STDERR_STORED - "\nend [amount]\n".length)}\nend [amount]\n`,
    ],
    ["", {}, null],
  ];
  for (const [stderr, secrets, tail] of vectors)
    expect(redactStderrTail(utf8(stderr), secrets)).toBe(tail);
});

it("cuts a long tail to 4 KiB without a split leading character", () => {
  const tail = redactStderrTail(utf8(`${polish.repeat(400)}kwota 12,50\n`), {});
  const full = utf8(`${polish.repeat(400)}kwota [amount]\n`);
  const expected = new TextDecoder().decode(full.subarray(full.length - 4096 + 1));
  expect(tail).toBe(expected);
  expect(tail?.startsWith("ń zażółć")).toBe(true);
  expect(utf8(tail ?? "").length).toBe(4095);
});

it("replaces the longest secret first and ignores empty values", () => {
  expect(withoutSecrets("key abcdef and abc", { a: "abc", b: "abcdef", c: "" })).toBe(
    "key [secret] and [secret]",
  );
});
