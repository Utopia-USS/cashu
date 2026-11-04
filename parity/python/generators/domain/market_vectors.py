"""Vectors for the TS port of market/yahoo.py `_price` (float32 noise removal) and `exchange_date`.

Synthetic inputs only (seeded random float32 values, edge cases); no data dir is read.
Run: .venv/bin/python parity/python/generators/domain/market_vectors.py > packages/domain/test/vectors/market-yahoo-price.jsonl
"""

import json
import random
import struct

from cashu.modules.investments.market.yahoo import _price, exchange_date


def f32(x: float) -> float:
    return struct.unpack("f", struct.pack("f", x))[0]


def main() -> None:
    rng = random.Random(18)
    values: list[float] = [0.0, -0.0, 0.5, 2.5, 1e-7, 3.4e38, 1e16, 1e-45, 166.22, 10000.3, 0.0123, 99.995, 9.9999]
    for _ in range(4000):
        magnitude = 10 ** rng.uniform(-6, 9)
        values.append(f32(rng.uniform(0, 1) * magnitude))
        values.append(rng.uniform(0, 1) * magnitude)  # a genuine double
        cents = rng.randrange(1, 10_000_000) / 100
        values.append(f32(cents))
        values.append(f32(rng.randrange(1, 1000) / 8))  # exact binary ties
    for v in values:
        try:
            price = _price(v)
        except ArithmeticError as error:  # decimal.InvalidOperation: too many digits to quantize
            print(json.dumps({"kind": "price", "in": repr(v), "error": type(error).__name__}))
            continue
        print(json.dumps({"kind": "price", "in": repr(v), "out": None if price is None else str(price)}))
    for _ in range(500):
        epoch = rng.randrange(0, 4_102_444_800)
        offset = rng.randrange(-12, 15) * 3600 + rng.choice((0, 1800, 2700))
        print(json.dumps({"kind": "date", "epoch": epoch, "offset": offset, "out": exchange_date(epoch, offset).isoformat()}))


if __name__ == "__main__":
    main()
