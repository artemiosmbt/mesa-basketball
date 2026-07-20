import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Supabase not configured");
    _supabase = createClient(url, key, { auth: { persistSession: false } });
  }
  return _supabase;
}

export interface Registration {
  id: string;
  created_at: string;
  parent_name: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  session_details: string;
  total_participants: number;
  booked_date: string | null;
  booked_start_time: string | null;
  booked_end_time: string | null;
  booked_location: string | null;
  booked_group: string | null;
  booked_trainer: string | null;
  status: string;
  manage_token: string;
  referral_code: string | null;
  is_free: boolean;
  used_referral_credit?: boolean;
  session_price: number | null;
  is_full_camp: boolean;
  sms_consent?: boolean;
  admin_change_at?: string | null;
  is_paid?: boolean;
  is_late_cancel?: boolean;
  cancel_fee_settled?: boolean;
  camp_day_late_fee?: number;
  camp_day_refund_issued?: number;
  camp_drop_in_rate?: number | null;
  applied_account_credit?: number;
  booking_batch_id?: string | null;
  stripe_checkout_session_id?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_customer_id?: string | null;
  stripe_refund_id?: string | null;
  package_id?: string | null;
}

export async function addRegistration(data: {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  sessionDetails: string;
  totalParticipants: number;
  bookedDate?: string;
  bookedStartTime?: string;
  bookedEndTime?: string;
  bookedLocation?: string;
  bookedGroup?: string;
  bookedTrainer?: string;
  usedReferralCredit?: boolean;
  isFree?: boolean;
  sessionPrice?: number;
  // Set when a reschedule needs real money to move before the new booking is
  // confirmed (see the Stripe reschedule topup flow) — mirrors the same
  // pending_payment/bookingBatchId pattern addRegistrationWithRewards uses.
  status?: string;
  bookingBatchId?: string;
  // Set when a reschedule DIDN'T need a fresh Stripe charge (same price, or
  // a refund of the difference) — carries the old booking's payment identity
  // forward so a later cancellation/reschedule of the new booking still
  // knows it was paid via Stripe and can refund it correctly.
  stripePaymentIntentId?: string;
  stripeCustomerId?: string;
  // Set when part (or all) of this booking's price was covered by account
  // credit rather than a fresh Stripe charge — e.g. a late reschedule's 50%
  // fee applied straight to the new session. A later cancellation/reschedule
  // of this row needs this to know how much to give back vs. how much (if
  // any) to actually refund through Stripe.
  appliedAccountCredit?: number;
  // Set when this rescheduled session is still covered by the same monthly
  // package that covered the old one (same month, still private) — $0,
  // no Stripe charge, just moving which date the package's slot applies to.
  packageId?: string;
}): Promise<{ manageToken: string }> {
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("registrations")
    .insert({
      parent_name: data.parentName,
      email: data.email,
      phone: data.phone,
      kids: data.kids,
      type: data.type,
      session_details: data.sessionDetails,
      total_participants: data.totalParticipants,
      booked_date: data.bookedDate || null,
      booked_start_time: data.bookedStartTime || null,
      booked_end_time: data.bookedEndTime || null,
      booked_location: data.bookedLocation || null,
      booked_group: data.bookedGroup || null,
      booked_trainer: data.bookedTrainer || null,
      ...(data.usedReferralCredit ? { used_referral_credit: true } : {}),
      ...(data.isFree ? { is_free: true } : {}),
      ...(data.sessionPrice != null ? { session_price: data.sessionPrice } : {}),
      ...(data.status ? { status: data.status } : {}),
      ...(data.bookingBatchId ? { booking_batch_id: data.bookingBatchId } : {}),
      ...(data.stripePaymentIntentId ? { stripe_payment_intent_id: data.stripePaymentIntentId } : {}),
      ...(data.stripeCustomerId ? { stripe_customer_id: data.stripeCustomerId } : {}),
      ...(data.appliedAccountCredit ? { applied_account_credit: data.appliedAccountCredit } : {}),
      ...(data.packageId ? { package_id: data.packageId } : {}),
    })
    .select("manage_token")
    .single();
  if (error) throw error;
  return { manageToken: row.manage_token };
}

export async function getBookedSlots(): Promise<
  { date: string; startTime: string; endTime: string; location: string; trainer: string }[]
> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("booked_date, booked_start_time, booked_end_time, booked_location, booked_trainer")
    .not("booked_date", "is", null)
    .eq("status", "confirmed")
    .in("type", ["private", "group-private"]);

  if (error) throw error;
  return (data || []).map((r) => ({
    date: r.booked_date,
    startTime: r.booked_start_time,
    endTime: r.booked_end_time,
    location: r.booked_location,
    trainer: r.booked_trainer || "Artemios Gavalas",
  }));
}

export async function getRegistrationByToken(
  token: string
): Promise<Registration | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("*")
    .eq("manage_token", token)
    .single();
  if (error) return null;
  return data as Registration;
}

export async function getRegistrationsByEmail(
  email: string
): Promise<Registration[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("*")
    .ilike("email", email.trim())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []) as Registration[];
}

// Returns true only if this call actually updated a row — same reasoning as
// cancelRegistration: a WHERE-clause update matching zero rows (e.g. the
// booking was cancelled a moment ago) isn't a Supabase error, so callers
// must check the real row count before proceeding (granting credit,
// sending notifications) as if the edit actually took effect.
export async function updateRegistrationPlayers(
  token: string,
  kids: string,
  totalParticipants: number,
  sessionPrice: number | null
): Promise<boolean> {
  const supabase = getSupabase();
  const update: Record<string, unknown> = { kids, total_participants: totalParticipants };
  if (sessionPrice !== null) update.session_price = sessionPrice;
  const { data, error } = await supabase
    .from("registrations")
    .update(update)
    .eq("manage_token", token)
    .eq("status", "confirmed")
    .select("id");
  return !error && !!data && data.length > 0;
}

/**
 * Returns true only if THIS call actually flipped the row — a WHERE-clause
 * update matching zero rows (e.g. someone/something already cancelled it a
 * moment ago) is not a Supabase error, so callers MUST check the returned
 * row count, not just the absence of an error, or a double-cancel (double
 * click, retry, race with another request) will silently re-run the full
 * refund flow a second time.
 */
export async function cancelRegistration(token: string, isLateCancel = false, campDayLateFee = 0): Promise<boolean> {
  const supabase = getSupabase();
  // applied_account_credit is zeroed here because the caller is responsible for
  // refunding that amount back to the account_credits balance right after this
  // call succeeds — zeroing it prevents the same credit being refunded twice if
  // this row is later swept up by a bulk cancellation (e.g. the full-camp fallback).
  const { data, error } = await supabase
    .from("registrations")
    .update({ status: "cancelled", is_late_cancel: isLateCancel, camp_day_late_fee: campDayLateFee, applied_account_credit: 0 })
    .eq("manage_token", token)
    .eq("status", "confirmed")
    .select("id");
  return !error && !!data && data.length > 0;
}

/** Record a completed Stripe refund on the row it was issued for (bookkeeping only). */
export async function recordStripeRefund(token: string, refundId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("registrations")
    .update({ stripe_refund_id: refundId })
    .eq("manage_token", token);
}

// Stamps how much was actually refunded/credited when THIS camp day was
// cancelled, so a later cancellation of another day in the same camp group
// can sum this across already-cancelled days and refund only the
// INCREMENTAL difference from here forward — never re-computing from the
// original full-camp price and re-refunding ground already covered.
export async function recordCampDayRefund(token: string, amount: number): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("registrations")
    .update({ camp_day_refund_issued: Math.round(amount) })
    .eq("manage_token", token);
}

/** Get every day-row sharing a referral_code for a full camp group, ordered by date. */
// referral_code alone isn't a unique purchase ID — it's the client's own permanent
// referral code, so it's identical across every full-camp purchase they've ever made.
// booked_group (the camp's own name) disambiguates which specific camp purchase this is.
export async function getCampGroupByReferralCode(referralCode: string, bookedGroup: string | null): Promise<Registration[]> {
  const supabase = getSupabase();
  let query = supabase
    .from("registrations")
    .select("*")
    .eq("referral_code", referralCode)
    .eq("type", "camp")
    .eq("is_full_camp", true);
  query = bookedGroup ? query.eq("booked_group", bookedGroup) : query.is("booked_group", null);
  const { data, error } = await query.order("booked_date", { ascending: true });
  if (error || !data) return [];
  return data as Registration[];
}

/**
 * Cancel all confirmed camp days sharing the same referral_code AND camp
 * (full camp cancellation). Returns true only if this call actually flipped
 * at least one row — see cancelRegistration's doc comment for why callers
 * must check row count, not just the absence of an error, before running
 * refund logic.
 */
export async function cancelFullCampByReferralCode(referralCode: string, bookedGroup: string | null): Promise<boolean> {
  const supabase = getSupabase();
  let query = supabase
    .from("registrations")
    .update({ status: "cancelled" })
    .eq("referral_code", referralCode)
    .eq("type", "camp")
    .eq("is_full_camp", true)
    .eq("status", "confirmed");
  query = bookedGroup ? query.eq("booked_group", bookedGroup) : query.is("booked_group", null);
  const { data, error } = await query.select("id");
  return !error && !!data && data.length > 0;
}

// --- Rewards & Referral Helpers ---

/** Get referral credits for an email */
export async function getReferralCredits(email: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("referral_credits")
    .select("credits")
    .eq("email", email)
    .single();
  if (error || !data) return 0;
  return data.credits || 0;
}

/** Add 1 referral credit to an email (upsert) */
export async function addReferralCredit(email: string): Promise<void> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("referral_credits")
    .select("credits, total_referrals")
    .eq("email", email)
    .single();

  if (data) {
    await supabase
      .from("referral_credits")
      .update({
        credits: (data.credits || 0) + 1,
        total_referrals: (data.total_referrals || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("email", email);
  } else {
    await supabase
      .from("referral_credits")
      .insert({ email, credits: 1, total_referrals: 1 });
  }
}

/** Use 1 referral credit (half-off session) */
export async function decrementReferralCredit(email: string): Promise<void> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("referral_credits")
    .select("credits")
    .eq("email", email)
    .single();
  if (data && (data.credits || 0) > 0) {
    await supabase
      .from("referral_credits")
      .update({ credits: data.credits - 1, updated_at: new Date().toISOString() })
      .eq("email", email);
  }
}

// --- Account Credit Helpers (dollar-value credit, e.g. from a partial camp
// cancellation, applied toward a future booking of any type) ---

/** Get account credit balance (dollars) for an email */
export async function getAccountCreditBalance(email: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("account_credits")
    .select("balance")
    .eq("email", email)
    .single();
  if (error || !data) return 0;
  return data.balance || 0;
}

/**
 * Add dollars to an email's account credit balance (upsert). Uses an
 * optimistic compare-and-swap (update only succeeds if the balance is still
 * what we just read) with a few retries instead of a plain read-then-write,
 * so two concurrent credits to the same email (e.g. two refunds landing at
 * once) can't silently clobber each other and lose one side's credit.
 */
export async function addAccountCredit(email: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const supabase = getSupabase();

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await supabase
      .from("account_credits")
      .select("balance")
      .eq("email", email)
      .single();

    if (!data) {
      // No row yet — insert wins the race outright, or fails with a unique
      // violation if another request just created it; either way, retry.
      const { error } = await supabase
        .from("account_credits")
        .insert({ email, balance: amount });
      if (!error) return;
      continue;
    }

    const currentBalance = data.balance || 0;
    const { data: updated, error } = await supabase
      .from("account_credits")
      .update({ balance: currentBalance + amount, updated_at: new Date().toISOString() })
      .eq("email", email)
      .eq("balance", currentBalance)
      .select("balance");
    if (!error && updated && updated.length > 0) return;
    // Someone else updated the balance between our read and write — retry with a fresh read.
  }
  console.error(`addAccountCredit: gave up after retries (email=${email}, amount=${amount}) — concurrent writes kept colliding`);
}

/**
 * Deduct dollars from an email's account credit balance. Returns false if
 * balance is insufficient. Same optimistic compare-and-swap as
 * addAccountCredit — a plain read-then-write here would let two concurrent
 * bookings both read the same balance and both apply a discount that only
 * one of them should have gotten.
 */
export async function deductAccountCredit(email: string, amount: number): Promise<boolean> {
  if (amount <= 0) return true;
  const supabase = getSupabase();

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await supabase
      .from("account_credits")
      .select("balance")
      .eq("email", email)
      .single();
    if (!data || (data.balance || 0) < amount) return false;

    const { data: updated, error } = await supabase
      .from("account_credits")
      .update({ balance: data.balance - amount, updated_at: new Date().toISOString() })
      .eq("email", email)
      .eq("balance", data.balance)
      .select("balance");
    if (!error && updated && updated.length > 0) return true;
    // Someone else updated the balance concurrently — retry with a fresh read
    // rather than deduct against a balance that's no longer accurate.
  }
  // Gave up after retries — safer to reject the credit than risk deducting
  // against a stale balance.
  return false;
}

/**
 * Records a late cancellation/reschedule fee event for the admin payments
 * page's recent-activity feed — purely informational, nothing else in the
 * app reads this. Best-effort: a logging failure must never block the
 * actual cancel/reschedule it's describing, which has already happened by
 * the time this runs.
 */
export async function logLateFeeEvent(event: {
  registrationId?: string;
  parentName: string;
  email?: string | null;
  kids?: string | null;
  sessionType?: string | null;
  sessionDetails?: string | null;
  bookedDate?: string | null;
  bookedStartTime?: string | null;
  action: "cancel" | "reschedule";
  initiatedBy: "client" | "admin";
  amountKept?: number;
  amountRefunded?: number;
  amountCredited?: number;
  amountApplied?: number;
  amountChargedExtra?: number;
  newSessionDetails?: string;
}): Promise<string | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.from("late_fee_events").insert({
      registration_id: event.registrationId,
      parent_name: event.parentName,
      email: event.email || null,
      kids: event.kids || null,
      session_type: event.sessionType || null,
      session_details: event.sessionDetails || null,
      booked_date: event.bookedDate || null,
      booked_start_time: event.bookedStartTime || null,
      action: event.action,
      initiated_by: event.initiatedBy,
      amount_kept: event.amountKept || 0,
      amount_refunded: event.amountRefunded || 0,
      amount_credited: event.amountCredited || 0,
      amount_applied: event.amountApplied || 0,
      amount_charged_extra: event.amountChargedExtra || 0,
      new_session_details: event.newSessionDetails || null,
    }).select("id").single();
    if (error) throw error;
    return data?.id ?? null;
  } catch (err) {
    console.error("Failed to log late fee event:", err);
    return null;
  }
}

// Fills in the actual charged amount on an existing late_fee_events row once
// a separate Stripe Checkout for the remainder actually completes — the
// initial log call deliberately omits amountChargedExtra for any path that
// redirects to its own Checkout Session, since logging it at creation time
// would record real money as "charged" before the client ever paid it (and
// permanently overstate it if they abandon that checkout).
export async function markLateFeeEventCharged(eventId: string, amountChargedExtra: number): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from("late_fee_events").update({ amount_charged_extra: amountChargedExtra }).eq("id", eventId);
  } catch (err) {
    console.error("Failed to mark late fee event as charged:", err);
  }
}

/** Check if email OR phone has any previous registrations (fraud-resistant new client check) */
export async function isNewClient(email: string, phone: string): Promise<boolean> {
  const supabase = getSupabase();
  const normalizedPhone = phone.replace(/\D/g, "").slice(-10); // last 10 digits
  const normalizedEmail = email.toLowerCase().trim();

  // Check existing_clients table (pre-launch clients added manually)
  const { data: existingRows } = await supabase
    .from("existing_clients")
    .select("phone");

  if (existingRows) {
    for (const row of existingRows) {
      const stored = (row.phone || "").replace(/\D/g, "").slice(-10);
      if (stored && stored === normalizedPhone) return false;
    }
  }

  // Check by email in registrations — only rows that represent a REAL past
  // booking count (confirmed at some point, later cancelled, or a no-show).
  // pending_payment/payment_abandoned rows are created the instant someone
  // starts a Stripe Checkout, before any payment happens — a closed tab or a
  // declined card must not permanently disqualify that email from the
  // first-time discount or a referral-code redemption.
  const REAL_STATUSES = ["confirmed", "cancelled", "no_show"];
  const { count: emailCount } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("email", normalizedEmail)
    .in("status", REAL_STATUSES);

  if ((emailCount || 0) > 0) return false;

  // Also fetch recent registrations to check phone (stored in various formats)
  const { data: phoneRows } = await supabase
    .from("registrations")
    .select("phone")
    .in("status", REAL_STATUSES)
    .limit(500);

  if (phoneRows) {
    for (const row of phoneRows) {
      const stored = (row.phone || "").replace(/\D/g, "").slice(-10);
      if (stored && stored === normalizedPhone) return false;
    }
  }

  return true;
}

/** Look up the email of the family that owns a referral code (checks profiles first, then registrations) */
export async function findReferrerByCode(code: string): Promise<string | null> {
  const supabase = getSupabase();
  const upper = code.toUpperCase();
  const { data: profile } = await supabase
    .from("profiles")
    .select("email")
    .eq("referral_code", upper)
    .maybeSingle();
  if (profile?.email) return profile.email;
  const { data, error } = await supabase
    .from("registrations")
    .select("email")
    .eq("referral_code", upper)
    .limit(1)
    .single();
  if (error || !data) return null;
  return data.email;
}

/** Look up the name and email of the family that owns a referral code (checks profiles first, then registrations) */
export async function findReferrerInfoByCode(code: string): Promise<{ email: string; name: string } | null> {
  const supabase = getSupabase();
  const upper = code.toUpperCase();
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, parent_name")
    .eq("referral_code", upper)
    .maybeSingle();
  if (profile?.email) return { email: profile.email, name: profile.parent_name || "" };
  const { data, error } = await supabase
    .from("registrations")
    .select("email, parent_name")
    .eq("referral_code", upper)
    .limit(1)
    .single();
  if (error || !data) return null;
  return { email: data.email, name: data.parent_name };
}

/** Generate a referral code from parent name: LASTNAME-MESA */
export function generateReferralCode(parentName: string): string {
  const parts = parentName.trim().split(/\s+/);
  const lastName = parts[parts.length - 1].toUpperCase().replace(/[^A-Z]/g, "");
  return `${lastName}-MESA`;
}

/** Get the referral code stored in a user's profile, if any */
export async function getProfileReferralCode(email: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("profiles")
    .select("referral_code")
    .eq("email", email)
    .maybeSingle();
  return data?.referral_code || null;
}

/** Check if a referral code is already taken by a different email */
export async function isReferralCodeTaken(code: string, excludeEmail: string): Promise<boolean> {
  const supabase = getSupabase();
  const upper = code.toUpperCase();
  // Check profiles table
  const { data: profileMatch } = await supabase
    .from("profiles")
    .select("email")
    .eq("referral_code", upper)
    .neq("email", excludeEmail)
    .maybeSingle();
  if (profileMatch) return true;
  // Fall back to registrations (legacy codes not yet in profiles)
  const { data: regMatch } = await supabase
    .from("registrations")
    .select("email")
    .eq("referral_code", upper)
    .neq("email", excludeEmail)
    .limit(1)
    .maybeSingle();
  return !!regMatch;
}

/**
 * Generate a unique referral code for a family.
 * Priority: profile-stored code → registrations-stored code → generate from profile name → generate from parentName arg.
 * The name used for generation is always the profile's stored name (not the booking form name),
 * so booking on behalf of someone else never changes your own code.
 */
export async function generateUniqueReferralCode(parentName: string, email: string): Promise<string> {
  const supabase = getSupabase();

  // 1. Check profiles table first (source of truth)
  const profileCode = await getProfileReferralCode(email);
  if (profileCode) return profileCode;

  // 2. Fall back to registrations for accounts that existed before profiles had referral_code
  const { data: existing } = await supabase
    .from("registrations")
    .select("referral_code")
    .eq("email", email)
    .not("referral_code", "is", null)
    .limit(1)
    .maybeSingle();

  if (existing?.referral_code) return existing.referral_code;

  // 3. Generate from the profile's stored name (not the booking form name)
  const { data: profile } = await supabase
    .from("profiles")
    .select("parent_name")
    .eq("email", email)
    .maybeSingle();

  const nameToUse = profile?.parent_name || parentName;
  const base = generateReferralCode(nameToUse);
  let code = base;
  let suffix = 2;

  while (true) {
    const taken = await isReferralCodeTaken(code, email);
    if (!taken) return code;
    code = `${base}${suffix}`;
    suffix++;
  }
}

/** Insert a registration with referral_code and is_free columns */
export async function addRegistrationWithRewards(data: {
  parentName: string;
  email: string;
  phone: string;
  kids: string;
  type: string;
  sessionDetails: string;
  totalParticipants: number;
  bookedDate?: string;
  bookedStartTime?: string;
  bookedEndTime?: string;
  bookedLocation?: string;
  bookedGroup?: string;
  bookedTrainer?: string;
  referralCode: string;
  isFree: boolean;
  usedReferralCredit?: boolean;
  smsConsent?: boolean;
  sessionPrice?: number;
  isFullCamp?: boolean;
  campDropInRate?: number;
  appliedAccountCredit?: number;
  // Stripe checkout support. When omitted, status keeps the DB default
  // ("confirmed") — only the new pay-via-Stripe path passes these.
  status?: string;
  bookingBatchId?: string;
  // Set when this session's price was covered by an active monthly package
  // rather than a Stripe charge — the specific package row, so cancel/
  // reschedule/no-show handling can tell a package-covered session apart
  // from one that just happened to be free/credit-covered for another
  // reason, and know which package's session count it affects.
  packageId?: string;
}): Promise<{ id: string; manageToken: string }> {
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("registrations")
    .insert({
      parent_name: data.parentName,
      email: data.email.toLowerCase().trim(),
      phone: data.phone,
      kids: data.kids,
      type: data.type,
      session_details: data.sessionDetails,
      total_participants: data.totalParticipants,
      booked_date: data.bookedDate || null,
      booked_start_time: data.bookedStartTime || null,
      booked_end_time: data.bookedEndTime || null,
      booked_location: data.bookedLocation || null,
      booked_group: data.bookedGroup || null,
      booked_trainer: data.bookedTrainer || null,
      referral_code: data.referralCode,
      is_free: data.isFree,
      used_referral_credit: data.usedReferralCredit ?? false,
      sms_consent: data.smsConsent ?? false,
      session_price: data.sessionPrice ?? null,
      is_full_camp: data.isFullCamp ?? false,
      camp_drop_in_rate: data.campDropInRate ?? null,
      applied_account_credit: data.appliedAccountCredit ?? 0,
      ...(data.status ? { status: data.status } : {}),
      ...(data.bookingBatchId ? { booking_batch_id: data.bookingBatchId } : {}),
      ...(data.packageId ? { package_id: data.packageId } : {}),
    })
    .select("id, manage_token")
    .single();
  if (error) throw error;
  return { id: row.id, manageToken: row.manage_token };
}

// --- Stripe checkout batch helpers ---
// A "batch" is every registrations row created together from one Stripe
// Checkout Session (one private booking today; a multi-session weekly
// booking or multi-day camp once those are wired up too). All rows in a
// batch share `booking_batch_id` and, once paid, the same
// `stripe_payment_intent_id`.

/** Stamp the Checkout Session id onto every row in a batch, right after creating it. */
export async function attachStripeCheckoutSession(bookingBatchId: string, checkoutSessionId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("registrations")
    .update({ stripe_checkout_session_id: checkoutSessionId })
    .eq("booking_batch_id", bookingBatchId);
}

export async function getRegistrationsByBatchId(bookingBatchId: string): Promise<Registration[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("*")
    .eq("booking_batch_id", bookingBatchId);
  if (error || !data) return [];
  return data as Registration[];
}

/**
 * Webhook calls this once payment succeeds: flips the whole batch from
 * pending_payment to confirmed and records the PaymentIntent (needed later
 * for refunds) and Customer id. Idempotent — if the batch is already
 * confirmed (a duplicate webhook delivery), this is a harmless no-op update.
 */
export async function finalizePaidBookingBatch(
  bookingBatchId: string,
  stripePaymentIntentId: string,
  stripeCustomerId: string | null
): Promise<Registration[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .update({
      status: "confirmed",
      stripe_payment_intent_id: stripePaymentIntentId,
      ...(stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : {}),
    })
    .eq("booking_batch_id", bookingBatchId)
    .eq("status", "pending_payment")
    .select("*");
  if (error || !data) return [];
  return data as Registration[];
}

/** Webhook calls this when a Checkout Session expires unused. */
export async function abandonPendingBookingBatch(bookingBatchId: string): Promise<Registration[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .update({ status: "payment_abandoned" })
    .eq("booking_batch_id", bookingBatchId)
    .eq("status", "pending_payment")
    .select("*");
  if (error || !data) return [];
  return data as Registration[];
}

/**
 * Safety net for the cron sweep: batch ids still pending_payment older than
 * the cutoff, in case a checkout.session.expired webhook delivery was
 * missed. Distinct batch ids only — a batch can have multiple rows once
 * weekly/camp bookings go through Stripe too.
 */
/**
 * Batches still pending_payment past the cutoff, along with the Stripe
 * Checkout Session id each one is tied to — the cron uses this id to ask
 * Stripe directly whether the session actually completed before assuming
 * it's abandoned (a missed/delayed webhook must not cause a real payment
 * to get marked "no charge" a couple hours later).
 */
export async function getStalePendingBatches(olderThanMs: number): Promise<{ bookingBatchId: string; checkoutSessionId: string | null }[]> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await supabase
    .from("registrations")
    .select("booking_batch_id, stripe_checkout_session_id")
    .eq("status", "pending_payment")
    .not("booking_batch_id", "is", null)
    .lt("created_at", cutoff);
  if (error || !data) return [];
  const seen = new Map<string, string | null>();
  for (const row of data) {
    const batchId = row.booking_batch_id as string;
    if (!seen.has(batchId)) seen.set(batchId, row.stripe_checkout_session_id ?? null);
  }
  return Array.from(seen.entries()).map(([bookingBatchId, checkoutSessionId]) => ({ bookingBatchId, checkoutSessionId }));
}

// --- Monthly Package Helpers ---

export interface MonthlyPackage {
  id: string;
  created_at: string;
  email: string;
  parent_name: string;
  phone: string;
  package_type: number;
  month_year: string;
  sessions_used: number;
  reminder_sent: boolean;
  status: string;
  stripe_checkout_session_id?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_customer_id?: string | null;
}

// Inserted as 'pending_payment' — the client is redirected to Stripe
// Checkout right after this, and the package only becomes usable
// (getActivePackage filters on status 'active') once the webhook confirms
// payment via finalizePaidPackage below.
export async function enrollInPackage(data: {
  email: string;
  parentName: string;
  phone: string;
  packageType: number;
  monthYear: string;
}): Promise<{ id: string }> {
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("monthly_packages")
    .insert({
      email: data.email.toLowerCase().trim(),
      parent_name: data.parentName,
      phone: data.phone,
      package_type: data.packageType,
      month_year: data.monthYear,
      sessions_used: 0,
      reminder_sent: false,
      status: "pending_payment",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: row.id };
}

export async function attachPackageCheckoutSession(packageId: string, checkoutSessionId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("monthly_packages")
    .update({ stripe_checkout_session_id: checkoutSessionId })
    .eq("id", packageId);
}

/**
 * Webhook calls this once payment succeeds: flips the package from
 * pending_payment to active and records the PaymentIntent. Row-count guard
 * (eq status pending_payment) means a duplicate webhook delivery is a no-op
 * — the confirmation email/SMS only fire when this actually flips something.
 */
export async function finalizePaidPackage(
  packageId: string,
  stripePaymentIntentId: string,
  stripeCustomerId: string | null
): Promise<MonthlyPackage | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .update({
      status: "active",
      stripe_payment_intent_id: stripePaymentIntentId,
      ...(stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : {}),
    })
    .eq("id", packageId)
    .eq("status", "pending_payment")
    .select("*")
    .single();
  if (error || !data) return null;
  return data as MonthlyPackage;
}

/** Webhook calls this when a Checkout Session expires unused. */
export async function abandonPendingPackage(packageId: string): Promise<MonthlyPackage | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .update({ status: "payment_abandoned" })
    .eq("id", packageId)
    .eq("status", "pending_payment")
    .select("*")
    .single();
  if (error || !data) return null;
  return data as MonthlyPackage;
}

/**
 * True if ANY session was ever booked against this package, regardless of
 * that session's current status — a client can only cancel a package
 * they've never actually used, and "used" here means "ever booked," not
 * "currently has an active session." Booking then cancelling a session
 * still permanently disqualifies the package from a full refund; otherwise
 * someone could book-then-cancel to reset eligibility.
 */
export async function packageHasAnyBookedSession(packageId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("registrations")
    .select("id")
    .eq("package_id", packageId)
    .limit(1);
  return !!data && data.length > 0;
}

/**
 * Client-initiated package cancellation (never used) — row-count guard
 * means a duplicate request (double click, retry) finds nothing left to
 * cancel, so the refund below never runs twice for the same package.
 */
export async function cancelPackage(packageId: string): Promise<MonthlyPackage | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .update({ status: "cancelled" })
    .eq("id", packageId)
    .eq("status", "active")
    .select("*")
    .single();
  if (error || !data) return null;
  return data as MonthlyPackage;
}

/** Safety net for the cron sweep, same convention as getStalePendingBatches. */
export async function getStalePendingPackages(olderThanMs: number): Promise<{ packageId: string; checkoutSessionId: string | null }[]> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await supabase
    .from("monthly_packages")
    .select("id, stripe_checkout_session_id")
    .eq("status", "pending_payment")
    .lt("created_at", cutoff);
  if (error || !data) return [];
  return data.map((row) => ({ packageId: row.id as string, checkoutSessionId: (row.stripe_checkout_session_id as string | null) ?? null }));
}

export async function getActivePackage(
  email: string,
  monthYear: string
): Promise<MonthlyPackage | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .select("*")
    .ilike("email", email.trim())
    .eq("month_year", monthYear)
    .eq("status", "active")
    .single();
  if (error || !data) return null;
  return data as MonthlyPackage;
}

/** True if a package already exists for this email+month, active or still
 *  mid-checkout — stops a client from starting a second Stripe Checkout for
 *  the same month before the first one even resolves. */
export async function hasPendingOrActivePackage(email: string, monthYear: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("monthly_packages")
    .select("id")
    .ilike("email", email.trim())
    .eq("month_year", monthYear)
    .in("status", ["active", "pending_payment"])
    .limit(1);
  return !!data && data.length > 0;
}

export async function incrementPackageSessions(id: string, currentUsed: number): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("monthly_packages")
    .update({ sessions_used: currentUsed + 1 })
    .eq("id", id);
}

export async function decrementPackageSessions(id: string, currentUsed: number): Promise<void> {
  const supabase = getSupabase();
  if (currentUsed <= 0) return;
  await supabase
    .from("monthly_packages")
    .update({ sessions_used: currentUsed - 1 })
    .eq("id", id);
}

/** Set sessions_used to an exact value (used for recalculation) */
export async function setPackageSessions(id: string, count: number): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("monthly_packages")
    .update({ sessions_used: count })
    .eq("id", id);
}

/**
 * Sessions actually charged against a specific package — package_id is set
 * on a row only when that exact package covered its price, so this is exact
 * (no email/phone fuzzy-matching, no risk of counting an individually-paid
 * overflow session against the package that didn't cover it). A no-show
 * still counts (the session slot is forfeited as the no-show penalty); a
 * cancelled or rescheduled-away row does not (the slot is freed back).
 */
export async function countPackageSessionsUsed(packageId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("id")
    .eq("package_id", packageId)
    .in("status", ["confirmed", "no_show"]);
  if (error || !data) return 0;
  return data.length;
}

export async function getPackageById(packageId: string): Promise<MonthlyPackage | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .select("*")
    .eq("id", packageId)
    .single();
  if (error || !data) return null;
  return data as MonthlyPackage;
}

export async function getPackagesNeedingReminder(monthYear: string): Promise<MonthlyPackage[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("monthly_packages")
    .select("*")
    .eq("month_year", monthYear)
    .eq("status", "active")
    .eq("reminder_sent", false);
  if (error || !data) return [];
  return (data as MonthlyPackage[]).filter((p) => p.sessions_used < p.package_type);
}

export async function markReminderSent(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("monthly_packages")
    .update({ reminder_sent: true })
    .eq("id", id);
}

/** Count confirmed weekly/camp registrations per session (by date + start time + group) */
export async function getGroupSessionEnrollment(): Promise<
  Record<string, number>
> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("booked_date, booked_start_time, booked_group, total_participants")
    .in("type", ["weekly", "camp"])
    .eq("status", "confirmed")
    .not("booked_date", "is", null);

  if (error || !data) return {};

  const counts: Record<string, number> = {};
  for (const row of data) {
    // Include the group label so two different groups/sessions at the same
    // date+time never share a capacity pool — each gets its own count.
    const key = `${row.booked_date}|${row.booked_start_time}|${row.booked_group || ""}`;
    counts[key] = (counts[key] || 0) + (row.total_participants || 1);
  }
  return counts;
}

// Used only for capacity (checkGroupSessionCapacity) — a genuine race
// between two DIFFERENT clients for the same last spot, where a
// pending_payment row briefly needs to count so a second client can't grab
// a spot while the first is still mid-Stripe-checkout. Stripe Checkout
// Sessions don't expire for a full 30 minutes (its own imposed minimum),
// far longer than anyone actually takes to pay, so this caps how long a
// single stale/abandoned checkout can hold a spot hostage from everyone
// else. (checkDuplicateRegistration doesn't use this — see its own comment:
// it can only ever find the SAME client's own row, never a real race.)
const PENDING_PAYMENT_GRACE_MS = 10 * 60 * 1000;

function pendingPaymentGraceFilter(): string {
  const cutoff = new Date(Date.now() - PENDING_PAYMENT_GRACE_MS).toISOString();
  return `status.eq.confirmed,and(status.eq.pending_payment,created_at.gte.${cutoff})`;
}

/** Check if a specific group session has capacity */
export async function checkGroupSessionCapacity(
  date: string,
  startTime: string,
  group: string,
  maxSpots: number
): Promise<{ available: boolean; enrolled: number }> {
  const supabase = getSupabase();
  // Confirmed rows always count; a pending_payment row only counts while
  // it's recent enough that someone could plausibly still be mid-checkout
  // (see PENDING_PAYMENT_GRACE_MS) — otherwise an abandoned checkout would
  // hold a "spot" for up to 30 minutes with nobody actually paying for it.
  const { count, error } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("type", "weekly")
    .or(pendingPaymentGraceFilter())
    .eq("booked_date", date)
    .eq("booked_start_time", startTime)
    .eq("booked_group", group || "");

  const enrolled = error ? 0 : count || 0;
  return { available: enrolled < maxSpots, enrolled };
}

export async function getRegistrantsBySession(
  date: string,
  startTime: string
): Promise<Registration[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("registrations")
    .select("*")
    .eq("booked_date", date)
    .eq("booked_start_time", startTime)
    .eq("status", "confirmed")
    .eq("type", "weekly");
  if (error) throw error;
  return (data || []) as Registration[];
}

export async function checkDuplicateRegistration(
  email: string,
  date: string,
  startTime: string
): Promise<boolean> {
  const supabase = getSupabase();
  // Filtered to this one email, so a pending_payment row found here can
  // NEVER be someone else's booking — it's always this same client's own
  // not-yet-paid attempt. Blocking on it (even briefly) traps a client who
  // backs out of Stripe and immediately tries again — e.g. to drop one
  // session from a 5-session order down to 4 — behind their own abandoned
  // checkout for no protective reason at all: nothing was charged, no spot
  // is genuinely theirs yet. Only a real, already-CONFIRMED (paid) booking
  // should ever block a re-registration. The old pending_payment row is left
  // untouched here (never mutated) — it simply expires normally later via
  // the checkout.session.expired webhook or the abandonment cron, exactly
  // as it would have anyway.
  const { count, error } = await supabase
    .from("registrations")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .eq("booked_date", date)
    .eq("booked_start_time", startTime)
    .eq("status", "confirmed");
  return !error && (count ?? 0) > 0;
}

