// Typed query of the list benchmark: the demo vault's transactions, newest first.
import { defineQuery } from "@cashu/store/query";

export const benchTransactions = defineQuery({
  id: "mobile.bench.transactions",
  run(read) {
    return read<{
      id: number;
      booking_date: string;
      amount: string;
      currency: string;
      counterparty_name: string | null;
      category: string | null;
    }>(
      "SELECT id, booking_date, amount, currency, counterparty_name, category FROM transactions ORDER BY booking_date DESC, id DESC",
    );
  },
});
