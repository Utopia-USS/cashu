// Upcasting (events.md 7.5): pure functions `(type, v) -> (type, v + 1)` applied on read. Stored
// events never change; the log keeps the original body, the fold sees the current version.

export type Payload = Record<string, unknown>;

/** Turns a payload of version `v` into version `v + 1`. Pure: no clock, no I/O, no gids minted. */
export type Upcaster = (data: Readonly<Payload>) => Payload;

/** Apply the upcasters `from -> from + 1 -> ... -> to`. Throws when a step is missing (a registry bug). */
export function upcast(
  type: string,
  data: Readonly<Payload>,
  from: number,
  to: number,
  upcasters: ReadonlyMap<number, Upcaster>,
): Payload {
  let out: Payload = { ...data };
  for (let v = from; v < to; v++) {
    const step = upcasters.get(v);
    if (!step) throw new Error(`missing upcaster ${type} v${v} -> v${v + 1}`);
    out = step(out);
  }
  return out;
}
