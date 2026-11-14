import { D, type Decimal } from "../decimal.js";

/** Python's `ZERO = Decimal("0.00")` of `core/networth.py`: sums start here, so they keep 2 places. */
export const ZERO_00: Decimal = D("0.00");
