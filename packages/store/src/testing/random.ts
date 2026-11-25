// Seeded randomness for tests: a deterministic PRNG, shuffles and batching. No real data.

/** Deterministic PRNG (mulberry32) and a seeded shuffle. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Split into consecutive batches of random size 1..max. */
export function chunked<T>(xs: readonly T[], seed: number, max = 4): T[][] {
  const r = rng(seed);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; ) {
    const n = 1 + Math.floor(r() * max);
    out.push(xs.slice(i, i + n));
    i += n;
  }
  return out;
}
