/**
 * AUDIT18 — canonical document line-item totals computation.
 *
 * The exact same quantity×price−discount+tax math was duplicated 6× on the
 * server (invoices POST/PUT, proformas POST/PUT, offers POST/PUT) and 3× on
 * the client (invoices-view, proformas-view, offers-view). audit17/F1 fixed
 * the SERVER copies to sum ROUNDED line components (VAT-compliance), but the
 * fix had to be applied by hand to each copy — and the CLIENT copies were
 * never updated, so the admin UI displays unrounded sums that can disagree
 * with the stored/PDF totals on penny-edge cases (2 lines × 10.254 → UI shows
 * 20.51, invoice stores 20.50).
 *
 * This module is the single source of truth, importable from BOTH server
 * routes and client components (pure function, no server dependencies).
 */

export interface DocLineItemInput {
  quantity?: number | string | null;
  unit_price?: number | string | null;
  discount?: number | string | null;
  tax_rate?: number | string | null;
}

export interface DocLineItemTotal extends Record<string, unknown> {
  quantity?: number | string | null;
  unit_price?: number | string | null;
  discount?: number | string | null;
  tax_rate?: number | string | null;
  total?: number;
}

export interface DocTotals {
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  items: DocLineItemTotal[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Recompute every line's total from its components and the header totals
 * from the rounded lines (audit17/F1 semantics — a VAT document whose line
 * items don't sum to its total is rejected by tax authorities).
 *
 * MUTATES the items array (sets `.total` per line, like the previous inline
 * loops did) and returns the four header totals, all rounded to 2dp.
 */
export function recomputeDocTotals<T extends DocLineItemInput>(items: T[]): DocTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const it of items) {
    const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
    const disc = (line * (Number(it.discount) || 0)) / 100;
    const net = line - disc;
    const tax = (net * (Number(it.tax_rate) || 0)) / 100;
    // Round each component to 2dp BEFORE aggregating, so the stored
    // it.total equals net+tax of the ROUNDED components and the header
    // sums the same rounded values (audit17 / F1).
    const rLine = round2(line);
    const rDisc = round2(disc);
    const rTax = round2(tax);
    const rNet = round2(net);
    subtotal += rLine;
    discountTotal += rDisc;
    taxTotal += rTax;
    (it as unknown as DocLineItemTotal).total = round2(rNet + rTax);
  }
  return {
    subtotal: round2(subtotal),
    discount_total: round2(discountTotal),
    tax_total: round2(taxTotal),
    total: round2(subtotal - discountTotal + taxTotal),
    items: items as unknown as DocLineItemTotal[],
  };
}

/**
 * Range validation for discount / tax percentages (audit17/F2 semantics).
 * Returns an error message for the first violation, or null when valid.
 */
export function validateLineItemRanges(items: DocLineItemInput[]): string | null {
  for (const it of items) {
    const disc = Number(it.discount) || 0;
    const tax = Number(it.tax_rate) || 0;
    if (disc < 0 || disc > 100) {
      return `Discount must be between 0 and 100 (got ${disc}).`;
    }
    if (tax < 0 || tax > 100) {
      return `Tax rate must be between 0 and 100 (got ${tax}).`;
    }
  }
  return null;
}

/** Client-side display helper: single-line total (rounded, same math as server). */
export function lineTotal(it: DocLineItemInput): number {
  const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
  const disc = (line * (Number(it.discount) || 0)) / 100;
  const net = line - disc;
  const tax = (net * (Number(it.tax_rate) || 0)) / 100;
  return round2(round2(net) + round2(tax));
}
