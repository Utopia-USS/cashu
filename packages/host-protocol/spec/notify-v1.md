# notify-v1 helper protocol

This private helper protocol carries no financial or profile data. It is independent of the host
session protocol version. Version 1 has one request and one ACK per helper process.

The request is exactly one UTF-8 JSON object followed by LF (`0a`) and EOF. Its field order and
grammar are fixed:

```
{"version":1,"requestId":"<uuid>","locale":"<locale>","kind":"<kind>","intentToken":"<token>"}\n
```

`uuid` is a lowercase RFC 4122 UUIDv4 (36 ASCII characters); `locale` is `pl` or `en`; `kind` is
`signal`, `signalsSummary`, `reviewDigest` or `generic`; `token` is exactly 64 lowercase hexadecimal
characters. The frame is at most 4096 bytes including LF. No CR, BOM, whitespace, second record or
trailing bytes are allowed. The serializer in `src/notify.ts` defines the byte order. A reader must
decode with fatal UTF-8, parse the JSON, serialize it canonically and require exact byte equality.
That rejects duplicate, missing and extra keys, alternate encodings, whitespace and reordered fields.

The ACK has the same framing rule and is at most 256 bytes including LF:

```
{"version":1,"requestId":"<uuid>","status":"<status>"}\n
```

`status` is `accepted`, `denied`, `pending`, `unavailable` or `rejected`. The ACK request ID must
equal the request ID. `rejected` is a definite refusal only when the helper proves OS submission
never started. EOF, timeout, crash, malformed ACK or any outcome after submission starts is
`unknown` at the host. `unknown` has no ACK encoding. The host deadline is ten seconds after spawn.

The request ID is an OS request and deduplication identifier. The token is a private locator, never
vault authority. Neither value belongs in argv, visible text, URL or logs. Visible copy is selected
only from the fixed packaged `notify-catalog-v1.json` by locale and kind.
