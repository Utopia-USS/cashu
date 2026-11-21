// Account shape the shared UI logic reads (GET /api/p/{slug}/accounts). Types only.

export interface Account {
  id: number;
  bank: string;
  /** The institution's display name ("Bank Millennium", "Revolut"); older servers leave it out. */
  bank_name?: string;
  name: string;
  type: string;
  currency: string;
  iban_tail: string;
  balance: number | null;
  as_of: string | null;
  is_liability: boolean;
}
