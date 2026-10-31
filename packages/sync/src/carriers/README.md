# packages/sync/src/carriers (S28b) and transports (S28c)

The production carrier of the own log (spike-result.md winner). The engine (`engine.ts`, S28a) owns
stamping, frames, frame groups, cursors and replication; this folder adds what makes it safe on real
storage. Wiring per device and vault:

```ts
const codec = createOwnLogCodec({ sodium, ring, floor }); // envelope + S27 frame
const folder = new FolderTransport({ fs: appFolderFs, owner: device }); // the synced directory
const remote = createOwnLogCarrier({ transport: folder, codec, device });
createSyncEngine({ vault, device, local, remotes: [remote], codec, sink, clockStore });
```

## Formats (all integers big-endian)

| What            | Bytes                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Folder layout   | `<vault>/<device>/<seq>.seg`, `<seq>` zero-padded to 6 digits, `000000.seg` = the manifest stream                                      |
| Segment         | `frame*`, frame = `u32 length \| sealed` (segment.ts)                                                                                  |
| Sealed          | S27 frame v2: `0x02 \| kid \| nonce \| XChaCha20-Poly1305(Padme(envelope))`, AAD binds vault, device, segment, offset                  |
| Envelope        | `0x00 \| body` (stored) or `0x01 \| u32 body length \| raw DEFLATE(body)`; body = the engine payload `{"f":1,"e":[...],"p"?}`          |
| Manifest record | segment 0 frames, same sealing; plaintext JSON `{"m":1,"k":"closed","s":N,"z":bytes}` / `"snapshot"` (`s`,`o`,`r`) / `"retired"` (`s`) |

- The codec byte lives inside the authenticated plaintext (S27 v2 = "no codec"), so a frame never
  opens under two interpretations. Inflation stops once output passes the declared length (cap 64 MiB):
  no zip bomb from a key holder. An unknown codec byte is `frame-format` (engine: needs upgrade).
- Compression runs before encryption; Padme bounds the size leak (crypto README m9). On the spike
  workload the log shrinks from 249 to 50 bytes per event.

## Guarantees

- **Manifest gate**: before creating segment N the writer records "N - 1 is final at S bytes"
  (sealed, position-bound). A reader exposes another device's segment N to the engine only when
  N - 1 is present up to S. Without it, on eventual storage, the engine applies N and moves its cursor
  past the rest of N - 1 (`folder.scenarios.test.ts` shows the loss). Holds are reported by
  `status(vault)`: `missing`, `incomplete`, `awaiting-manifest`, `compacted`, `conflict`.
- **Folder transport**: each device writes only its directory; appends write a temp dot-file, fsync,
  rename (no in-place rewrite, no torn file from the writer). Conflict copies (`x (1).seg`, `x 2.seg`,
  `x.sync-conflict-*.seg`, ...) are versions of one append-only file: prefix-consistent versions merge
  into the longest (the writer deletes them on its next append); diverging versions (a cloned device id)
  expose only the common prefix and are reported as forks. iCloud placeholders (`.x.seg.icloud`) are
  reported as evicted. An unreachable folder must surface as `TransportError("unavailable")` (port contract).
- **Writer key floor** (`WriterKeyFloor`, crypto README "S28b"): after `raise(revocationGeneration)`,
  a writer's frames under older keys are refused once that writer has written at the floor (positional,
  history stays readable). S29 persists `state()`.
- **Compaction hooks** (S32 builds compaction): `markSnapshot`, `retireBefore`, `snapshots`, and the
  reader option `resumeFrom` to start a stream at an installed snapshot.

## Not covered here (owners)

- Per-device signed heads / frame signatures (withholding, truncation of a whole tail, forks): S28d.
- The desktop `FolderFs` adapter (Node `fs`) belongs to the app; `testing/node-fs.ts` is the test one.
- iOS ubiquity container (download of evicted files, change notifications): risk R7.
