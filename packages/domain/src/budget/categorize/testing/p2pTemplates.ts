/**
 * The S09 review's synthetic person-to-person titles (17 templates) and inflected Polish names,
 * for the cloud-gate leak tests. Invented names only.
 */
import { D } from "../../../decimal.js";
import type { CloudRow } from "../cloudGate.js";

export const P2P_TEMPLATES: readonly string[] = [
  "PRZELEW DLA {n}",
  "ZWROT {n}",
  "{n} ZA OBIAD",
  "BLIK PRZELEW NA TELEFON {n}",
  "{n} {n2} CZYNSZ",
  "OD {n} {n2}",
  "{n}{n2}",
  "{n} {n2} ZA PIZZĘ I KINO",
  "{n} {n2} UL. POLNA 5",
  "{n}-{n2}",
  "{n} {n2} {n3} {n4} {n5}",
  "{n} {n2} 48123456789",
  "{n} {n2} OPLATA",
  "DLA {n} {n2} PREZENT",
  "ZWROT DLA {n} {n2} ZA PIZZE",
  "{n} {n2} PAYPAL",
  "{n}",
];

const NAMES = [
  "Anna",
  "Annie",
  "Annę",
  "Anny",
  "Jan",
  "Janowi",
  "Jana",
  "Kowalski",
  "Kowalskiemu",
  "Kowalskiego",
  "Kowalskiej",
  "Nowak",
  "Nowakowi",
  "Wiśniewska",
  "Łukasz",
  "Łukaszowi",
  "Żaneta",
  "Grzegorz",
  "Brzęczyszczykiewicz",
  "Małgorzata",
  "Ola",
  "Piotr",
  "Zając",
  "Dąbrowski",
  "Michał",
  "J.",
  "M",
];

/** Deterministic 32-bit LCG (tests never use Math.random). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

export interface Rendered {
  readonly text: string;
  readonly names: readonly string[];
}

/** `count` renderings of one template with names drawn from `seed`. */
export function render(template: string, seed: number, count: number): Rendered[] {
  const next = lcg(seed);
  const pick = () => NAMES[Math.floor(next() * NAMES.length)] as string;
  return Array.from({ length: count }, () => {
    const names: string[] = [];
    const text = template.replace(/\{n\d?\}/g, () => {
      const n = next() < 0.15 ? pick().toUpperCase() : pick();
      names.push(n);
      return n;
    });
    return { text, names };
  });
}

/** P2P phrases a bank puts in a title or description of a transfer without an account number. */
export const P2P_DESCRIPTIONS: readonly string[] = [
  "PRZELEW NA TELEFON",
  "Przelew BLIK na telefon 48 123 456 789",
  "BLIK P2P",
  "przelew na numer telefonu",
  "Przelew od",
];

const AMOUNT = D("-25.00");

/** A transfer to a person with a counterparty account number (name in the counterparty field). */
export function ibanRow(r: Rendered): CloudRow {
  return {
    amount: AMOUNT,
    counterpartyName: r.text,
    counterpartyIban: "99 1000 0000 0000 0000 0000 0042",
    reference: r.text,
    description: null,
    isInternalTransfer: false,
    source: "default",
  };
}

/** A BLIK-to-phone style transfer: no account number, the P2P phrase in the description. */
export function markerRow(r: Rendered, description: string): CloudRow {
  return {
    amount: AMOUNT,
    counterpartyName: null,
    counterpartyIban: null,
    reference: r.text,
    description,
    isInternalTransfer: false,
    source: "default",
  };
}

/** A plain card-style row (no account number, no marker) with the same text. */
export function bareRow(r: Rendered): CloudRow {
  return { ...markerRow(r, ""), description: null };
}

/** Card merchants that must stay eligible (the gate is not trivially empty). */
export const CARD_MERCHANTS: readonly CloudRow[] = [
  "ZABKA Z1234 KRAKOW",
  "SKLEP TESTOWY SP. Z O.O.",
  "MCDONALDS 1234",
].map((reference) => ({
  amount: AMOUNT,
  counterpartyName: null,
  counterpartyIban: null,
  reference,
  description: "ZAKUP PRZY UZYCIU KARTY",
  isInternalTransfer: false,
  source: "default",
}));
