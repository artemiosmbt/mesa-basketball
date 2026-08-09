/**
 * Card vs Link payment-method lookup, shared by every revenue/payroll sync
 * that needs the real Stripe fee % for a charge — Stripe charges a lower %
 * on Link (2.7%+$0.30) than a plain card (2.9%+$0.30). Which one a given
 * checkout actually used isn't stored anywhere in Supabase, only on the
 * Stripe PaymentIntent itself, so this looks it up live and caches the
 * result in a hidden tab (keyed by payment_intent_id — a completed
 * transaction's payment method never changes, so once looked up it never
 * needs re-fetching) on WHICHEVER spreadsheet the caller passes in. Each
 * sync keeps its own separate cache tab on its own spreadsheet — same
 * isolation principle already used elsewhere in this codebase (e.g.
 * payroll-sync.ts deliberately not sharing code/state with the site's own
 * DB access), so nothing here can couple two independent sync jobs together.
 */
import { getStripe } from "./stripe";
import { a1Quote, batchUpdate, getSheetMeta, getValues, updateValues } from "./sheets-write";

export const STRIPE_PCT_CARD = 0.029;
export const STRIPE_PCT_LINK = 0.027; // Stripe charges a lower % when the customer pays via Link instead of a plain card
export const STRIPE_FIXED = 0.3; // same fixed $0.30 for both

export const PAYMENT_METHOD_CACHE_TAB = "_PaymentMethodCache";
// Bounds how many NEW (uncached) Stripe lookups happen in a single run —
// sync functions have a limited execution window, and each lookup is a
// real network call. Any payment intent that doesn't fit this run's budget
// falls back to the card rate for now and gets looked up (and corrected)
// on a later run.
export const MAX_STRIPE_LOOKUPS_PER_RUN = 40;

export async function ensurePaymentMethodCacheTab(spreadsheetId: string): Promise<void> {
  const meta = await getSheetMeta(spreadsheetId);
  if (meta.some((s) => s.title === PAYMENT_METHOD_CACHE_TAB)) return;
  await batchUpdate(spreadsheetId, [
    { addSheet: { properties: { title: PAYMENT_METHOD_CACHE_TAB, hidden: true } } },
  ]);
  await updateValues(spreadsheetId, `${a1Quote(PAYMENT_METHOD_CACHE_TAB)}!A1:B1`, [["payment_intent_id", "method_type"]]);
}

export async function readPaymentMethodCache(spreadsheetId: string): Promise<Map<string, string>> {
  const rows = await getValues(spreadsheetId, `${a1Quote(PAYMENT_METHOD_CACHE_TAB)}!A2:B`);
  const map = new Map<string, string>();
  for (const r of rows) {
    const [id, type] = r as [string, string];
    if (id) map.set(id, type || "card");
  }
  return map;
}

export function stripePctForMethod(methodType: string): number {
  return methodType === "link" ? STRIPE_PCT_LINK : STRIPE_PCT_CARD;
}

export interface ResolvedPaymentMethod {
  pct: number;
  label: "Credit Card" | "Link";
}

/** Resolves the real payment method for a payment intent — cached first,
 * else a single live lookup (budget-limited), else falls back to the card
 * rate/label. Returns both the fee % and the human label from ONE lookup,
 * so a caller that needs both (payroll-sync.ts writes the label AND uses
 * the % to compute the real fee) never pays for the Stripe API call twice. */
export async function resolvePaymentMethod(
  paymentIntentId: string | null,
  cache: Map<string, string>,
  cacheWrites: Map<string, string>,
  budget: { remaining: number }
): Promise<ResolvedPaymentMethod> {
  const fallback: ResolvedPaymentMethod = { pct: STRIPE_PCT_CARD, label: "Credit Card" };
  if (!paymentIntentId) return fallback;
  const cached = cache.get(paymentIntentId);
  if (cached) return { pct: stripePctForMethod(cached), label: cached === "link" ? "Link" : "Credit Card" };
  if (budget.remaining <= 0) return fallback; // picked up on a future run instead
  budget.remaining--;
  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
    const methodType = typeof pi.payment_method === "object" && pi.payment_method ? pi.payment_method.type : "card";
    cache.set(paymentIntentId, methodType);
    cacheWrites.set(paymentIntentId, methodType);
    return { pct: stripePctForMethod(methodType), label: methodType === "link" ? "Link" : "Credit Card" };
  } catch {
    // Unretrievable (bad id, test-mode leftover, transient error) — default
    // to card rather than fail the whole sync over one fee refinement.
    return fallback;
  }
}

/** Convenience wrapper for callers that only need the fee %, not the label
 * (monthly-revenue-sync.ts's existing call sites). */
export async function resolveStripePct(
  paymentIntentId: string | null,
  cache: Map<string, string>,
  cacheWrites: Map<string, string>,
  budget: { remaining: number }
): Promise<number> {
  return (await resolvePaymentMethod(paymentIntentId, cache, cacheWrites, budget)).pct;
}
