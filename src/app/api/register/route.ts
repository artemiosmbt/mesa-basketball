import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { SERVICE_FEE, fmtMoney, PRIVATE_RATE, GROUP_PRIVATE_RATE } from "@/lib/pricing";
import { getWeeklySchedule, getCamps } from "@/lib/sheets";
import {
  finalizeConfirmedPrivateBooking,
  finalizeConfirmedPrivateSeriesBooking,
  finalizeConfirmedWeeklyBooking,
  finalizeConfirmedCampBooking,
} from "@/lib/booking-finalize";
import {
  addRegistrationWithRewards,
  isNewClient,
  getReferralCredits,
  decrementReferralCredit,
  findReferrerInfoByCode,
  generateUniqueReferralCode,
  checkGroupSessionCapacity,
  checkCampCapacity,
  checkDuplicateRegistration,
  getAccountCreditBalance,
  deductAccountCredit,
  attachStripeCheckoutSession,
  getActivePackage,
  countPackageSessionsUsed,
  isRateLimited,
} from "@/lib/supabase";

// For each booked date (in order), the active package (if any) whose
// remaining capacity covers it — consumed first-come-first-served within
// the request, tracked per month since a recurring series can span more
// than one. A session covered this way needs no Stripe charge at all: the
// package was already paid for in full, upfront, separately. Coverage is
// counted against package_id specifically (not "any private session this
// email had this month"), so an individually-paid overflow session never
// eats into a package's count. Packages only ever cover standard private
// sessions (up to 3 kids, $150/hr) — never group-private (4+, $250/hr):
// a package slot is priced around the private rate, so a 4+ kid session
// always charges normally regardless of remaining capacity.
// Splits `total` across items weighted by `weights` so every item's share
// sums EXACTLY back to `total` (e.g. $11 credit split 3 ways by equal
// weight -> $4/$4/$3, never $4/$4/$4 = $12). Used to record account credit
// on EVERY row of a multi-row booking (not just the first), proportional to
// each row's own price — critical so that later cancelling any single row
// independently refunds/credits exactly that row's fair share, never more
// or less than what was actually applied to it. A weight of 0 (e.g. a
// package-covered or already-free row) always gets exactly $0.
function splitProportional(total: number, weights: number[]): number[] {
  const sumWeights = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return weights.map(() => 0);
  // A positive total with all-zero weights has no real proportions to work
  // from — not reachable through either current call site (both derive
  // total from the same weights it's being split across), but returning
  // all-zeros here would silently make that total vanish without landing on
  // any row at all, rather than at least splitting it evenly, if some future
  // caller ever did pass an independently-computed total.
  if (sumWeights <= 0) {
    const n = weights.length;
    if (n === 0) return [];
    return splitProportional(total, weights.map(() => 1));
  }
  let cumulativeWeight = 0;
  let cumulativeShare = 0;
  return weights.map((w) => {
    cumulativeWeight += w;
    // Round to the nearest CENT, not the nearest dollar — weekly
    // volume-discount pricing routinely lands on fractional dollars (e.g. a
    // $30 session at the 15%-off tier is $25.50 exactly). Rounding to whole
    // dollars here stamped a $0.50 phantom overage onto applied_account_credit
    // for every such row, which then got refunded right back on cancellation
    // — real money drift on every book-then-cancel cycle for any fractional
    // total, even though nothing was ever actually charged wrong.
    const nextShare = Math.round((total * cumulativeWeight * 100) / sumWeights) / 100;
    const share = Math.round((nextShare - cumulativeShare) * 100) / 100;
    cumulativeShare = nextShare;
    return share;
  });
}

// Capacity/duplicate checks only ever look at what's already in the
// database — they can't catch the SAME session appearing twice within this
// one submission (a client-side bug, a replay, or a fast double-click before
// the UI re-renders to hide an already-selected option). Both copies would
// otherwise sail through those checks and get inserted, silently
// double-booking/double-charging the same slot in one order.
function findWithinRequestDuplicateDates(sessions: { date: string; startTime: string }[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const s of sessions) {
    const key = `${s.date}|${s.startTime}`;
    if (seen.has(key)) dupes.push(s.date);
    else seen.add(key);
  }
  return dupes;
}

// A one-time, ad-hoc Stripe coupon so Checkout's own page shows the account
// credit as a real line item deduction — "Account Credit -$X" — rather than
// baking it invisibly into a single reduced total. Line items keep their
// full, undiscounted prices; Stripe applies this against the whole order
// total, landing on the exact same final amount either way.
async function buildCreditDiscount(stripe: ReturnType<typeof getStripe>, creditApplied: number): Promise<{ coupon: string }[] | undefined> {
  if (creditApplied <= 0) return undefined;
  const coupon = await stripe.coupons.create({
    amount_off: Math.round(creditApplied * 100),
    currency: "usd",
    duration: "once",
    name: "Account Credit",
  });
  return [{ coupon: coupon.id }];
}

async function allocatePackageCoverage(email: string, dates: string[], kidCount: number): Promise<Array<{ covered: boolean; packageId: string | null }>> {
  if (kidCount >= 4) {
    return dates.map(() => ({ covered: false, packageId: null }));
  }
  const remainingByMonth = new Map<string, { packageId: string; remaining: number }>();
  const result: Array<{ covered: boolean; packageId: string | null }> = [];
  for (const dateStr of dates) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      result.push({ covered: false, packageId: null });
      continue;
    }
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!remainingByMonth.has(month)) {
      const pkg = await getActivePackage(email, month);
      if (pkg) {
        const used = await countPackageSessionsUsed(pkg.id);
        remainingByMonth.set(month, { packageId: pkg.id, remaining: Math.max(0, pkg.package_type - used) });
      } else {
        remainingByMonth.set(month, { packageId: "", remaining: 0 });
      }
    }
    const entry = remainingByMonth.get(month)!;
    if (entry.remaining > 0) {
      result.push({ covered: true, packageId: entry.packageId });
      remainingByMonth.set(month, { ...entry, remaining: entry.remaining - 1 });
    } else {
      result.push({ covered: false, packageId: null });
    }
  }
  return result;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      parentName,
      email: rawEmail,
      phone,
      kids,
      type,
      sessionDetails,
      totalParticipants,
      bookedDate,
      bookedStartTime,
      bookedEndTime,
      bookedLocation,
      bookedTrainer,
      submittedReferralCode,
      smsConsent,
      // Weekly multi-session fields — the client's own price fields
      // (weeklyTotalPrice) are intentionally NOT read here anymore; price
      // is always re-verified against the live sheet instead (see below).
      weeklySessions,
      // Camp multi-day fields — likewise, campTotalPrice/campTotalDays/
      // campDropInRate are intentionally not read; verified from the live
      // sheet instead.
      campSessions,
      // Recurring private multi-date fields — one row per date, one Stripe
      // charge for the total (see the branch below).
      privateSessions,
      // Referral credit opt-in
      useReferralCredit,
      // Account credit opt-in (dollar-value credit from e.g. a partial camp cancellation)
      applyAccountCredit,
    } = body;
    // Normalized once at the boundary — every downstream check (self-referral
    // comparison, isNewClient, checkDuplicateRegistration) relies on this
    // matching the lowercased/trimmed form already stored for the referrer.
    const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : rawEmail;

    if (!parentName || !email || !phone || !kids || !type || !sessionDetails) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Zero abuse protection existed here before — a script could repeatedly
    // submit garbage bookings (within already-enforced participant bounds)
    // to squat a session's capacity, or spam referral/notification side
    // effects. Keyed by IP, email, AND phone together (not either/or) so a
    // script rotating fake emails each time still trips the phone/IP key,
    // and vice versa.
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const [ipLimited, emailLimited, phoneLimited] = await Promise.all([
      isRateLimited(`register:ip:${ip}`, 20, 10 * 60 * 1000),
      isRateLimited(`register:email:${email}`, 8, 10 * 60 * 1000),
      isRateLimited(`register:phone:${phone}`, 8, 10 * 60 * 1000),
    ]);
    if (ipLimited || emailLimited || phoneLimited) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }

    // Validated once at the boundary — every price computation below trusts
    // this to be a real, positive, reasonably-bounded headcount. Unvalidated,
    // a negative value (e.g. -1) drives every "totalParticipants || 1"
    // fallback below to still take the negative number (only 0/null/undefined
    // fall back to 1), making a session's price computable to $0 or negative,
    // clamping to a free ($0-to-charge) confirmed booking with no Stripe
    // interaction at all — while still firing real SMS/email notifications
    // and, with a referral code, minting a real referral credit.
    if (totalParticipants !== undefined) {
      if (!Number.isInteger(totalParticipants) || totalParticipants < 1 || totalParticipants > 12) {
        return NextResponse.json(
          { error: "Invalid number of participants" },
          { status: 400 }
        );
      }
    }

    // Handle weekly multi-session registration
    if (type === "weekly" && weeklySessions && weeklySessions.length > 0) {
      const referralCode = await generateUniqueReferralCode(parentName, email);

      // Check referral BEFORE saving (isNewClient returns false after registration is stored)
      let weeklyReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode) {
        const newClient = await isNewClient(email, phone);
        if (newClient) {
          const info = await findReferrerInfoByCode(submittedReferralCode);
          if (info && info.email.toLowerCase().trim() !== email) {
            weeklyReferrer = info;
          }
        }
      }

      const withinRequestDupes = findWithinRequestDuplicateDates(weeklySessions);
      if (withinRequestDupes.length > 0) {
        return NextResponse.json(
          { error: `The same session was selected more than once: ${withinRequestDupes.join(", ")}. Please try again.` },
          { status: 400 }
        );
      }

      // Check capacity for all selected sessions
      const capacityChecks = await Promise.all(
        weeklySessions.map((s: { date: string; startTime: string; endTime: string; location: string; group: string; maxSpots: number }) =>
          checkGroupSessionCapacity(s.date, s.startTime, s.group, s.maxSpots)
        )
      );

      const fullSessions = weeklySessions.filter(
        (_: unknown, i: number) => !capacityChecks[i].available
      );
      if (fullSessions.length > 0) {
        const fullDates = fullSessions.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `The following sessions are full: ${fullDates}. Please deselect them and try again.` },
          { status: 400 }
        );
      }

      // Check for duplicate registrations
      const duplicateChecks = await Promise.all(
        weeklySessions.map((s: { date: string; startTime: string }) =>
          checkDuplicateRegistration(email, s.date, s.startTime)
        )
      );
      const duplicateSessions = weeklySessions.filter((_: unknown, i: number) => duplicateChecks[i]);
      if (duplicateSessions.length > 0) {
        const dupDates = duplicateSessions.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `This email is already registered for the following session${duplicateSessions.length > 1 ? "s" : ""}: ${dupDates}. Please deselect ${duplicateSessions.length > 1 ? "them" : "it"} and try again.` },
          { status: 400 }
        );
      }

      // Re-verify pricing against the live sheet — never trust
      // weeklyTotalPrice sent from the client. It reflects whatever price
      // the browser happened to have loaded, which could be stale (the
      // sheet changed since) or simply wrong if the request was tampered
      // with, and this is the only place real money gets decided.
      const liveWeeklySchedule = await getWeeklySchedule({ noCache: true });
      const liveWeeklyMatches = weeklySessions.map((s: { date: string; startTime: string; group: string }) =>
        liveWeeklySchedule.find((ls) => ls.group === s.group && ls.date === s.date && ls.startTime === s.startTime)
      );
      const unmatchedSessions = weeklySessions.filter((_: unknown, i: number) => !liveWeeklyMatches[i]);
      if (unmatchedSessions.length > 0) {
        const dates = unmatchedSessions.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `Couldn't verify current pricing for: ${dates}. The schedule may have changed — please refresh and try again.` },
          { status: 400 }
        );
      }
      // Same multi-session volume-discount tiers shown on the booking form
      // (4+ sessions = 10% off, 8+ = 15% off) — but applied PER GROUP, not
      // across the whole request. A submission can now span more than one
      // group at once (e.g. a group skills session plus its companion
      // pickup slot, cross-sold on the booking form), each with its own
      // live rate and its own discount tier based on how many sessions of
      // THAT group are in this request, never blended with another group's
      // price or count.
      const groupCounts = new Map<string, number>();
      for (const s of weeklySessions) groupCounts.set(s.group, (groupCounts.get(s.group) || 0) + 1);
      const perSessionPrices: number[] = weeklySessions.map((s: { group: string }, i: number) => {
        const liveMatch = liveWeeklyMatches[i]!;
        const groupCount = groupCounts.get(s.group)!;
        const volumeDiscountPct = groupCount >= 8 ? 0.15 : groupCount >= 4 ? 0.10 : 0;
        const unitPrice = Math.round(liveMatch.price * (1 - volumeDiscountPct) * 100) / 100;
        return Math.round(unitPrice * (totalParticipants || 1) * 100) / 100;
      });
      const weeklyTotal = Math.round(perSessionPrices.reduce((sum: number, p: number) => sum + p, 0) * 100) / 100;

      // Account credit can cover the WHOLE booking, not just one session —
      // split proportionally across every row, weighted by each row's own
      // price (so a cheaper pickup slot doesn't absorb the same credit
      // share as a pricier skills session) — so that cancelling any single
      // session later refunds/credits exactly its own fair share, never
      // more or less than what was actually applied to it.
      let weeklyCreditApplied = 0;
      if (applyAccountCredit && weeklyTotal > 0) {
        const balance = await getAccountCreditBalance(email);
        weeklyCreditApplied = Math.min(balance, weeklyTotal);
        if (weeklyCreditApplied > 0) await deductAccountCredit(email, weeklyCreditApplied);
      }
      const weeklyCreditShares = weeklyCreditApplied > 0
        ? splitProportional(weeklyCreditApplied, perSessionPrices)
        : [];

      const amountToCharge = Math.max(0, weeklyTotal - weeklyCreditApplied);
      const bookingBatchId = crypto.randomUUID();

      for (const [i, session] of weeklySessions.entries()) {
        await addRegistrationWithRewards({
          parentName,
          email,
          phone,
          kids,
          type: "weekly",
          sessionDetails: `${session.group} — ${session.date} ${session.startTime}-${session.endTime} at ${session.location}`,
          totalParticipants: totalParticipants || 1,
          bookedDate: session.date,
          bookedStartTime: session.startTime,
          bookedEndTime: session.endTime,
          bookedLocation: session.location,
          bookedGroup: session.group,
          bookedTrainer: session.trainer,
          referralCode,
          isFree: false,
          smsConsent: !!smsConsent,
          sessionPrice: perSessionPrices[i],
          ...(weeklyCreditShares[i] > 0 ? { appliedAccountCredit: weeklyCreditShares[i] } : {}),
          status: amountToCharge > 0 ? "pending_payment" : undefined,
          bookingBatchId,
        });
      }

      const weeklyFinalizeParams = {
        parentName,
        email,
        phone,
        kids,
        weeklySessions: weeklySessions as Array<{ date: string; startTime: string; endTime: string; location: string; group: string; trainer?: string; maxSpots?: number }>,
        totalParticipants: totalParticipants || 1,
        referralCode,
        weeklyReferrer,
        submittedReferralCode: submittedReferralCode || undefined,
        smsConsent: !!smsConsent,
        weeklyTotalPrice: weeklyTotal,
        weeklyCreditApplied,
      };

      if (amountToCharge === 0) {
        // Fully covered by account credit — nothing to actually charge, so
        // confirm immediately exactly like before Stripe existed.
        await finalizeConfirmedWeeklyBooking(weeklyFinalizeParams);
        return NextResponse.json({ success: true, count: weeklySessions.length, referralApplied: !!weeklyReferrer });
      }

      // Real money is due — send them to Stripe instead of confirming yet.
      const stripe = getStripe();
      const origin = req.nextUrl.origin;

      // Itemize per group (one line item each) at the FULL pre-credit price
      // — same "GroupName x3" shape shown on our own page — rather than one
      // opaque lump sum, so Stripe's own checkout page shows the same
      // breakdown. Each group's line item uses THAT group's own per-session
      // price (which already reflects its own live rate and its own
      // volume-discount tier), not a blended average across groups.
      const groupSubtotals = new Map<string, number>();
      weeklySessions.forEach((s: { group: string }, i: number) => {
        groupSubtotals.set(s.group, Math.round(((groupSubtotals.get(s.group) || 0) + perSessionPrices[i]) * 100) / 100);
      });
      const weeklyLineItems = Array.from(groupCounts.entries()).map(([group, count]) => ({
        price_data: {
          currency: "usd",
          product_data: { name: count > 1 ? `${group} x${count}` : group },
          unit_amount: Math.round((groupSubtotals.get(group) || 0) * 100),
        },
        quantity: 1,
      }));

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_creation: "always",
        // Save the card for a legitimate future off-session charge — used
        // when an admin charges a late-reschedule remainder automatically.
        payment_intent_data: { setup_future_usage: "off_session" },
        customer_email: email,
        client_reference_id: bookingBatchId,
        discounts: await buildCreditDiscount(stripe, weeklyCreditApplied),
        metadata: {
          booking_batch_id: bookingBatchId,
          referrer_email: weeklyReferrer?.email || "",
          referrer_name: weeklyReferrer?.name || "",
          submitted_referral_code: submittedReferralCode || "",
          total_price: String(weeklyTotal),
        },
        line_items: [
          ...weeklyLineItems,
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Service Fee" },
              unit_amount: Math.round(SERVICE_FEE * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/schedule?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      });

      await attachStripeCheckoutSession(bookingBatchId, session.id);

      return NextResponse.json({ success: true, checkoutUrl: session.url });
    }

    // Handle camp multi-day registration
    if (type === "camp" && campSessions && campSessions.length > 0) {
      const referralCode = await generateUniqueReferralCode(parentName, email);

      // Check referral BEFORE saving (isNewClient returns false after registration is stored)
      let campReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode) {
        const newClient = await isNewClient(email, phone);
        if (newClient) {
          const info = await findReferrerInfoByCode(submittedReferralCode);
          if (info && info.email.toLowerCase().trim() !== email) {
            campReferrer = info;
          }
        }
      }

      const withinRequestCampDupes = findWithinRequestDuplicateDates(campSessions);
      if (withinRequestCampDupes.length > 0) {
        return NextResponse.json(
          { error: `The same camp day was selected more than once: ${withinRequestCampDupes.join(", ")}. Please try again.` },
          { status: 400 }
        );
      }

      // Check for duplicate camp day registrations
      const campDuplicateChecks = await Promise.all(
        campSessions.map((s: { date: string; startTime: string }) =>
          checkDuplicateRegistration(email, s.date, s.startTime)
        )
      );
      const duplicateCampDays = campSessions.filter((_: unknown, i: number) => campDuplicateChecks[i]);
      if (duplicateCampDays.length > 0) {
        const dupDates = duplicateCampDays.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `This email is already registered for the following camp day${duplicateCampDays.length > 1 ? "s" : ""}: ${dupDates}. Please deselect ${duplicateCampDays.length > 1 ? "them" : "it"} and try again.` },
          { status: 400 }
        );
      }

      // Re-verify pricing against the live sheet — never trust
      // campTotalPrice/campTotalDays sent from the client, which reflect
      // whatever the browser had loaded (possibly stale, or tampered with)
      // rather than what's actually on the sheet right now. Mirrors
      // calcCampPrice()/isEarlyBirdActive() on the booking form exactly, just
      // computed from freshly-fetched data instead of trusted client input.
      const liveCamps = await getCamps({ noCache: true });
      const firstCampSession = campSessions[0];
      const liveCamp = liveCamps.find((c) =>
        c.name === firstCampSession.campName && (firstCampSession.gradeGroup ? c.gradeGroup === firstCampSession.gradeGroup : true)
      );
      if (!liveCamp) {
        return NextResponse.json(
          { error: "Couldn't verify current pricing for this camp — it may no longer be on the schedule. Please refresh and try again." },
          { status: 400 }
        );
      }
      const liveTotalDays = liveCamp.campDays.length || campSessions.length;
      const campKidCount = Math.max(1, totalParticipants || 1);

      // Camps had NO server-side capacity check at all (only a client-side
      // UI limit) — a camp could be oversold either by two legitimate
      // simultaneous bookings racing each other, or trivially by calling
      // this endpoint directly. Checked per selected day, same as weekly.
      const campCapacityChecks = await Promise.all(
        campSessions.map((s: { date: string; startTime: string }) =>
          checkCampCapacity(s.date, s.startTime, firstCampSession.campName, liveCamp.maxSpots, campKidCount)
        )
      );
      const fullCampDays = campSessions.filter((_: unknown, i: number) => !campCapacityChecks[i].available);
      if (fullCampDays.length > 0) {
        const fullDates = fullCampDays.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `The following camp day${fullCampDays.length > 1 ? "s are" : " is"} full: ${fullDates}. Please deselect ${fullCampDays.length > 1 ? "them" : "it"} and try again.` },
          { status: 400 }
        );
      }

      const earlyBirdActive = new Date() < new Date("2026-04-01T04:00:00Z");
      const fullBaseStr = earlyBirdActive && liveCamp.earlyBirdPrice ? liveCamp.earlyBirdPrice : liveCamp.price;
      const fullBase = (parseInt(fullBaseStr.replace(/\D/g, "")) || 0) * campKidCount;
      const isFullCamp = campSessions.length === liveTotalDays;
      let campTotalNum: number;
      if (isFullCamp) {
        campTotalNum = fullBase;
      } else {
        const perDay = parseInt((liveCamp.dropInPrice || "").replace(/\D/g, "")) || 100;
        campTotalNum = Math.min(perDay * campSessions.length * campKidCount, fullBase);
      }
      if (campTotalNum <= 0) {
        return NextResponse.json({ error: "Invalid camp price" }, { status: 400 });
      }

      // Splits `total` across `days` so every day's share sums EXACTLY back to
      // the total — Math.round(total/days) applied identically to every day
      // can round the same way on every row (e.g. $11 over 2 days -> $6 and
      // $6), and since each drop-in day is later refunded independently,
      // that would let cumulative refunds exceed what was actually charged.
      // Rounds to the nearest CENT, not the nearest dollar — same fix as
      // splitProportional, needed for the same reason: a fractional-dollar
      // total (e.g. a discounted or early-bird camp price) would otherwise
      // stamp a phantom overage onto applied_account_credit that gets
      // refunded right back on cancellation.
      function dropInDayPrice(index: number, total: number, days: number): number {
        return Math.round((total * (index + 1) * 100) / days) / 100 - Math.round((total * index * 100) / days) / 100;
      }

      // Full camp: every row stores the SAME total price (the per-day
      // cancellation cap math and the 50% full-cancel fee both need every row
      // in the group to agree on the same "original" price). Drop-in: each
      // day gets its own share via the exact split above.
      const firstDayPrice = isFullCamp ? campTotalNum : dropInDayPrice(0, campTotalNum, campSessions.length);

      // Account credit can cover the whole registration (up to the full
      // total), not just one day — split evenly across every day (full camp
      // or drop-in alike) the same way each day's own price is already
      // split, so cancelling any single day always refunds/credits exactly
      // its own fair share right away rather than only whichever day
      // happened to hold it all. This is safe for a full-camp day cancelled
      // while others remain: cancelRegistration zeroes applied_account_credit
      // on the cancelled row specifically so the whole-group cancel path's
      // later aggregate (which sums applied_account_credit across every row
      // still in the group) never double-counts a share already refunded.
      let campCreditApplied = 0;
      if (applyAccountCredit) {
        const balance = await getAccountCreditBalance(email);
        campCreditApplied = Math.min(balance, campTotalNum);
        if (campCreditApplied > 0) await deductAccountCredit(email, campCreditApplied);
      }

      const amountToCharge = Math.max(0, campTotalNum - campCreditApplied);
      const bookingBatchId = crypto.randomUUID();

      for (const [i, session] of campSessions.entries()) {
        const dayPrice = isFullCamp ? campTotalNum : dropInDayPrice(i, campTotalNum, campSessions.length);
        const dayCredit = campCreditApplied > 0 ? dropInDayPrice(i, campCreditApplied, campSessions.length) : 0;
        await addRegistrationWithRewards({
          parentName,
          email,
          phone,
          kids,
          type: "camp",
          sessionDetails: `${session.campName}${session.gradeGroup ? ` — ${session.gradeGroup}` : ""} — ${session.date} ${session.startTime}${session.endTime ? `-${session.endTime}` : ""} at ${session.location}`,
          totalParticipants: totalParticipants || 1,
          bookedDate: session.date,
          bookedStartTime: session.startTime,
          bookedEndTime: session.endTime || "",
          bookedLocation: session.location,
          bookedGroup: session.campName,
          referralCode,
          isFree: false,
          smsConsent: !!smsConsent,
          sessionPrice: dayPrice,
          isFullCamp,
          // Stored for later per-day cancellation math on a full-camp
          // booking — sourced from the live sheet's drop-in rate, never the
          // client, since it directly affects a future refund calculation.
          ...(isFullCamp ? { campDropInRate: parseInt((liveCamp.dropInPrice || "").replace(/\D/g, "")) || undefined } : {}),
          ...(dayCredit > 0 ? { appliedAccountCredit: dayCredit } : {}),
          status: amountToCharge > 0 ? "pending_payment" : undefined,
          bookingBatchId,
        });
      }

      const firstSession = campSessions[0];
      const campFinalizeParams = {
        parentName,
        email,
        phone,
        kids,
        campSessions: campSessions as Array<{ date: string; startTime: string; endTime?: string; location: string; campName: string; gradeGroup?: string }>,
        totalParticipants: totalParticipants || 1,
        referralCode,
        campReferrer,
        submittedReferralCode: submittedReferralCode || undefined,
        smsConsent: !!smsConsent,
        campTotalPrice: `$${fmtMoney(campTotalNum)}`,
        campTotalNum,
        campCreditApplied,
        sessionPrice: firstDayPrice,
      };

      if (amountToCharge === 0) {
        // Fully covered by account credit — nothing to actually charge, so
        // confirm immediately exactly like before Stripe existed.
        await finalizeConfirmedCampBooking(campFinalizeParams);
        return NextResponse.json({ success: true, count: campSessions.length, referralApplied: !!campReferrer });
      }

      // Real money is due — send them to Stripe instead of confirming yet.
      const stripe = getStripe();
      const origin = req.nextUrl.origin;
      const campNameLine = `${firstSession.campName}${firstSession.gradeGroup ? ` — ${firstSession.gradeGroup}` : ""}`;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_creation: "always",
        // Save the card for a legitimate future off-session charge — used
        // when an admin charges a late-reschedule remainder automatically.
        payment_intent_data: { setup_future_usage: "off_session" },
        customer_email: email,
        client_reference_id: bookingBatchId,
        discounts: await buildCreditDiscount(stripe, campCreditApplied),
        metadata: {
          booking_batch_id: bookingBatchId,
          referrer_email: campReferrer?.email || "",
          referrer_name: campReferrer?.name || "",
          submitted_referral_code: submittedReferralCode || "",
          total_price: `$${fmtMoney(campTotalNum)}`,
          camp_grade_group: firstSession.gradeGroup || "",
        },
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: campSessions.length > 1 ? `${campNameLine} x${campSessions.length} days` : campNameLine },
              // Full pre-credit total — the discount coupon above (if any)
              // handles the credit deduction, same as the weekly/private
              // checkouts, so Stripe's own page itemizes it the same way
              // our form does instead of baking it into one reduced number.
              unit_amount: Math.round(campTotalNum * 100),
            },
            quantity: 1,
          },
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Service Fee" },
              unit_amount: Math.round(SERVICE_FEE * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/schedule?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      });

      await attachStripeCheckoutSession(bookingBatchId, session.id);

      return NextResponse.json({ success: true, checkoutUrl: session.url });
    }

    const isPrivateType = type === "private" || type === "group-private";
    const referralCode = await generateUniqueReferralCode(parentName, email);

    // Compute the full (undiscounted) price for private sessions from the booked duration.
    // is_free flag handles the 50% discount at display time.
    function parseMinsFromTime(t?: string): number {
      if (!t) return 0;
      const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!m) return 0;
      let h = parseInt(m[1]);
      const min = parseInt(m[2]);
      if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
      if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
      return h * 60 + min;
    }
    function calcPrivateSessionPrice(startTime?: string, endTime?: string, kidCount = 1): number | undefined {
      if (!startTime || !endTime) return undefined;
      const duration = Math.max(60, parseMinsFromTime(endTime) - parseMinsFromTime(startTime));
      const rate = kidCount >= 4 ? GROUP_PRIVATE_RATE : PRIVATE_RATE;
      return Math.round(rate * (duration / 60) * 100) / 100;
    }

    // Multi-date recurring private/group-private booking — one row per
    // selected date, one Stripe Checkout Session for the total. Replaces the
    // old pattern of N separate /api/register calls plus a trailing
    // emailOnly call just to send one combined email.
    if (isPrivateType && privateSessions && privateSessions.length > 0) {
      if (privateSessions.some((s: { date?: string; startTime?: string; endTime?: string; location?: string }) => !s.date || !s.startTime || !s.endTime || !s.location)) {
        return NextResponse.json({ error: "Missing session details" }, { status: 400 });
      }

      const newClient = await isNewClient(email, phone);
      let privateReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode && newClient) {
        const info = await findReferrerInfoByCode(submittedReferralCode);
        if (info && info.email.toLowerCase().trim() !== email) {
          privateReferrer = info;
        }
      }

      const withinRequestPrivateDupes = findWithinRequestDuplicateDates(privateSessions);
      if (withinRequestPrivateDupes.length > 0) {
        return NextResponse.json(
          { error: `The same date was selected more than once: ${withinRequestPrivateDupes.join(", ")}. Please try again.` },
          { status: 400 }
        );
      }

      const duplicateChecks = await Promise.all(
        privateSessions.map((s: { date: string; startTime: string }) => checkDuplicateRegistration(email, s.date, s.startTime))
      );
      const duplicateSessions = privateSessions.filter((_: unknown, i: number) => duplicateChecks[i]);
      if (duplicateSessions.length > 0) {
        const dupDates = duplicateSessions.map((s: { date: string }) => s.date).join(", ");
        return NextResponse.json(
          { error: `This email is already registered for the following session${duplicateSessions.length > 1 ? "s" : ""}: ${dupDates}. Please deselect ${duplicateSessions.length > 1 ? "them" : "it"} and try again.` },
          { status: 400 }
        );
      }

      // Checked before the first-time/referral-credit logic below — a date
      // covered by an active package (possibly more than just the first
      // date, if the package has enough remaining capacity) is already
      // fully prepaid, so it shouldn't also consume the one-time discount
      // or a referral credit that could instead apply to a future booking.
      const packageCoverage = await allocatePackageCoverage(email, privateSessions.map((s: { date: string }) => s.date), totalParticipants || 1);

      // Only the FIRST (non-package-covered) date in the series can carry
      // the first-time discount or a redeemed referral credit — by the
      // second date, isNewClient would already read false anyway (a row now
      // exists for this email), so this just makes explicit that the
      // discount is a one-time thing, not "free for every date in the series."
      let isFirstTime = false;
      let firstIsFree = false;
      let usedReferralCredit = false;
      if (!packageCoverage[0]?.covered) {
        if (newClient) {
          firstIsFree = true;
          isFirstTime = true;
        } else if (useReferralCredit) {
          const credits = await getReferralCredits(email);
          if (credits > 0) {
            firstIsFree = true;
            usedReferralCredit = true;
            await decrementReferralCredit(email);
          }
        }
      }

      const pricedSessions = privateSessions.map((s: { date: string; startTime: string; endTime: string; location: string; trainer?: string }, i: number) => {
        const fullPrice = calcPrivateSessionPrice(s.startTime, s.endTime, totalParticipants || 1) ?? 0;
        const packageCovered = packageCoverage[i]?.covered ?? false;
        const packageId = packageCoverage[i]?.packageId ?? null;
        const isFree = !packageCovered && i === 0 && firstIsFree;
        const effectivePrice = packageCovered ? 0 : isFree ? Math.round(fullPrice * 0.5 * 100) / 100 : fullPrice;
        return { ...s, fullPrice, effectivePrice, isFree, packageCovered, packageId };
      });

      // Package-covered dates are already fully prepaid — split them out and
      // confirm them immediately, completely independent of whatever happens
      // with the rest of the series. Bundling them into the same
      // pending_payment/Stripe batch as dates that DO need payment used to
      // mean a package-covered date could get stuck waiting on (or even
      // wiped out by) an unrelated Stripe checkout for a different date —
      // if that checkout was abandoned, the whole batch — package-covered
      // dates included — flipped to payment_abandoned, silently dropping a
      // session that should've just been confirmed for free.
      type PricedSession = (typeof pricedSessions)[number];
      const coveredSessions = pricedSessions.filter((s: PricedSession) => s.packageCovered);
      const uncoveredSessions = pricedSessions.filter((s: PricedSession) => !s.packageCovered);

      if (coveredSessions.length > 0) {
        const coveredBatchId = crypto.randomUUID();
        for (const s of coveredSessions) {
          await addRegistrationWithRewards({
            parentName,
            email,
            phone,
            kids,
            type,
            sessionDetails: `Private Session — ${s.date} ${s.startTime}-${s.endTime} at ${s.location}`,
            totalParticipants: totalParticipants || 1,
            bookedDate: s.date,
            bookedStartTime: s.startTime,
            bookedEndTime: s.endTime,
            bookedLocation: s.location,
            bookedTrainer: s.trainer,
            referralCode,
            isFree: false,
            smsConsent: !!smsConsent,
            sessionPrice: s.fullPrice,
            bookingBatchId: coveredBatchId,
            ...(s.packageId ? { packageId: s.packageId } : {}),
          });
        }
        await finalizeConfirmedPrivateSeriesBooking({
          parentName,
          email,
          phone,
          kids,
          type,
          privateSessions: coveredSessions as Array<{ date: string; startTime: string; endTime: string; location: string; trainer?: string; fullPrice: number; isFree: boolean; packageCovered?: boolean }>,
          totalParticipants: totalParticipants || 1,
          referralCode,
          privateReferrer: null,
          submittedReferralCode: undefined,
          smsConsent: !!smsConsent,
          isFirstTime: false,
          accountCreditApplied: 0,
        });
      }

      if (uncoveredSessions.length === 0) {
        // Every date was package-covered — nothing left to charge or send
        // to Stripe at all.
        return NextResponse.json({ success: true, count: privateSessions.length, referralApplied: !!privateReferrer });
      }

      const totalBeforeCredit = uncoveredSessions.reduce((sum: number, s: PricedSession) => sum + s.effectivePrice, 0);

      // Account credit can cover the whole (non-package) portion of the
      // series, up to its total. Split proportionally across every
      // uncovered date by its own effectivePrice (so a first-time-free date
      // correctly gets a half share) — not just recorded on the first row —
      // so that cancelling any single date later refunds/credits exactly
      // its own fair share.
      let accountCreditApplied = 0;
      if (applyAccountCredit && totalBeforeCredit > 0) {
        const balance = await getAccountCreditBalance(email);
        accountCreditApplied = Math.min(balance, totalBeforeCredit);
        if (accountCreditApplied > 0) await deductAccountCredit(email, accountCreditApplied);
      }
      const accountCreditShares = accountCreditApplied > 0
        ? splitProportional(accountCreditApplied, uncoveredSessions.map((s: PricedSession) => s.effectivePrice))
        : [];

      const amountToCharge = Math.max(0, totalBeforeCredit - accountCreditApplied);
      const bookingBatchId = crypto.randomUUID();

      for (const [i, s] of uncoveredSessions.entries()) {
        await addRegistrationWithRewards({
          parentName,
          email,
          phone,
          kids,
          type,
          sessionDetails: `Private Session — ${s.date} ${s.startTime}-${s.endTime} at ${s.location}`,
          totalParticipants: totalParticipants || 1,
          bookedDate: s.date,
          bookedStartTime: s.startTime,
          bookedEndTime: s.endTime,
          bookedLocation: s.location,
          bookedTrainer: s.trainer,
          referralCode,
          isFree: s.isFree,
          usedReferralCredit: i === 0 && usedReferralCredit,
          smsConsent: !!smsConsent,
          sessionPrice: s.fullPrice,
          ...(accountCreditShares[i] > 0 ? { appliedAccountCredit: accountCreditShares[i] } : {}),
          status: amountToCharge > 0 ? "pending_payment" : undefined,
          bookingBatchId,
        });
      }

      const seriesFinalizeParams = {
        parentName,
        email,
        phone,
        kids,
        type,
        privateSessions: uncoveredSessions as Array<{ date: string; startTime: string; endTime: string; location: string; trainer?: string; fullPrice: number; isFree: boolean; packageCovered?: boolean }>,
        totalParticipants: totalParticipants || 1,
        referralCode,
        privateReferrer,
        submittedReferralCode: submittedReferralCode || undefined,
        smsConsent: !!smsConsent,
        isFirstTime,
        accountCreditApplied,
      };

      if (amountToCharge === 0) {
        // Fully covered by discount + credit — nothing to actually charge,
        // so confirm immediately exactly like before Stripe existed.
        await finalizeConfirmedPrivateSeriesBooking(seriesFinalizeParams);
        return NextResponse.json({ success: true, count: privateSessions.length, referralApplied: !!privateReferrer });
      }

      // Real money is due — send them to Stripe instead of confirming yet.
      const stripe = getStripe();
      const origin = req.nextUrl.origin;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_creation: "always",
        // Save the card for a legitimate future off-session charge — used
        // when an admin charges a late-reschedule remainder automatically.
        payment_intent_data: { setup_future_usage: "off_session" },
        customer_email: email,
        client_reference_id: bookingBatchId,
        discounts: await buildCreditDiscount(stripe, accountCreditApplied),
        metadata: {
          booking_batch_id: bookingBatchId,
          is_first_time: String(isFirstTime),
          referrer_email: privateReferrer?.email || "",
          referrer_name: privateReferrer?.name || "",
          submitted_referral_code: submittedReferralCode || "",
        },
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: uncoveredSessions.length > 1 ? `Private Session x${uncoveredSessions.length}` : "Private Session" },
              // Full pre-credit total (still net of any referral/first-time
              // discount, which isn't shown as its own line) — the discount
              // coupon above handles the credit deduction as its own line.
              unit_amount: Math.round(totalBeforeCredit * 100),
            },
            quantity: 1,
          },
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Service Fee" },
              unit_amount: Math.round(SERVICE_FEE * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/schedule?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      });

      await attachStripeCheckoutSession(bookingBatchId, session.id);

      return NextResponse.json({ success: true, checkoutUrl: session.url, packageCoveredCount: coveredSessions.length });
    }

    // Single-date private/group-private booking, paid via Stripe.
    if (isPrivateType && !privateSessions) {
      if (!bookedDate || !bookedStartTime || !bookedEndTime || !bookedLocation) {
        return NextResponse.json({ error: "Missing session details" }, { status: 400 });
      }

      const newClient = await isNewClient(email, phone);
      let privateReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode && newClient) {
        const info = await findReferrerInfoByCode(submittedReferralCode);
        if (info && info.email.toLowerCase().trim() !== email) {
          privateReferrer = info;
        }
      }

      // Already covered by an active monthly package? Check this before any
      // discount/credit logic — a package-covered session is already fully
      // prepaid, so it shouldn't also spend a referral credit or "waste" the
      // first-time discount that could instead apply to a future session.
      const { covered: packageCovered, packageId } = (await allocatePackageCoverage(email, [bookedDate], totalParticipants || 1))[0];
      // A package-covered session is $0 due to Stripe — no incremental
      // revenue to justify awarding the referrer a real credit. isNewClient
      // only checks past registrations (never monthly_packages), so a
      // client whose first-ever registration row is package-covered would
      // otherwise still mint a real referral credit off a transaction Mesa
      // collected nothing extra for. Matches the private-series path, which
      // already nulls this out for the same reason.
      if (packageCovered) privateReferrer = null;

      let isFree = false;
      let isFirstTime = false;
      let usedReferralCredit = false;
      if (!packageCovered) {
        if (newClient) {
          isFree = true; // first-time 50% off
          isFirstTime = true;
        } else if (useReferralCredit) {
          const credits = await getReferralCredits(email);
          if (credits > 0) {
            isFree = true;
            usedReferralCredit = true;
            await decrementReferralCredit(email);
          }
        }
      }

      const privateSessionPrice = calcPrivateSessionPrice(bookedStartTime, bookedEndTime, totalParticipants || 1);

      const effectivePrice = packageCovered
        ? 0
        : isFree && privateSessionPrice != null
          ? Math.round(privateSessionPrice * 0.5 * 100) / 100
          : (privateSessionPrice ?? 0);

      // Cap against the DISCOUNTED (effective) price, never the full
      // undiscounted one — otherwise a first-time/referral-discount client
      // with enough balance to exceed what the session actually costs after
      // the discount gets that excess silently deducted from their real
      // credit balance for nothing (amountToCharge would still floor at 0,
      // so the card is never overcharged, but the balance vanishes anyway).
      let accountCreditApplied = 0;
      if (!packageCovered && applyAccountCredit && effectivePrice > 0) {
        const balance = await getAccountCreditBalance(email);
        accountCreditApplied = Math.min(balance, effectivePrice);
        if (accountCreditApplied > 0) await deductAccountCredit(email, accountCreditApplied);
      }

      const amountToCharge = Math.max(0, effectivePrice - accountCreditApplied);

      const bookingBatchId = crypto.randomUUID();
      const insertResult = await addRegistrationWithRewards({
        parentName,
        email,
        phone,
        kids,
        type,
        sessionDetails,
        totalParticipants: totalParticipants || 1,
        bookedDate,
        bookedStartTime,
        bookedEndTime,
        bookedLocation,
        bookedTrainer: isPrivateType ? bookedTrainer : undefined,
        referralCode,
        isFree,
        usedReferralCredit,
        smsConsent: !!smsConsent,
        sessionPrice: privateSessionPrice,
        ...(accountCreditApplied > 0 ? { appliedAccountCredit: accountCreditApplied } : {}),
        status: amountToCharge > 0 ? "pending_payment" : undefined,
        bookingBatchId,
        ...(packageId ? { packageId } : {}),
      });

      if (amountToCharge === 0) {
        // Fully covered by discount + credit — nothing to actually charge,
        // so confirm immediately exactly like before Stripe existed.
        await finalizeConfirmedPrivateBooking({
          parentName,
          email,
          phone,
          kids,
          type,
          sessionDetails,
          totalParticipants: totalParticipants || 1,
          bookedDate,
          bookedStartTime,
          bookedEndTime,
          bookedLocation,
          bookedTrainer: isPrivateType ? bookedTrainer : undefined,
          manageToken: insertResult.manageToken,
          isFree,
          isFirstTime,
          referralCode,
          privateReferrer,
          submittedReferralCode: submittedReferralCode || undefined,
          smsConsent: !!smsConsent,
          accountCreditApplied,
          fullPrice: privateSessionPrice,
          packageCovered,
        });
        return NextResponse.json({ success: true, isFree, referralApplied: !!privateReferrer });
      }

      // Real money is due — send them to Stripe instead of confirming yet.
      // The booking stays pending_payment until the webhook confirms payment.
      const stripe = getStripe();
      const plainSessionDetails = sessionDetails.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
      const origin = req.nextUrl.origin;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_creation: "always",
        // Save the card for a legitimate future off-session charge — used
        // when an admin charges a late-reschedule remainder automatically.
        payment_intent_data: { setup_future_usage: "off_session" },
        customer_email: email,
        client_reference_id: bookingBatchId,
        discounts: await buildCreditDiscount(stripe, accountCreditApplied),
        // The webhook runs in a separate request with no access to this
        // request's body, so anything the finalize step needs beyond what's
        // already stored on the pending row (referrer info, first-time vs
        // referral-credit distinction) has to ride along in metadata —
        // small facts only, not booking data, which stays in Supabase.
        metadata: {
          booking_batch_id: bookingBatchId,
          is_first_time: String(isFirstTime),
          referrer_email: privateReferrer?.email || "",
          referrer_name: privateReferrer?.name || "",
          submitted_referral_code: submittedReferralCode || "",
        },
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: plainSessionDetails || "Mesa Basketball Training Session" },
              // Full pre-credit price (still net of any referral/first-time
              // discount) — the discount coupon above handles the credit
              // deduction as its own line on Stripe's own page.
              unit_amount: Math.round(effectivePrice * 100),
            },
            quantity: 1,
          },
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Service Fee" },
              unit_amount: Math.round(SERVICE_FEE * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/schedule?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      });

      await attachStripeCheckoutSession(bookingBatchId, session.id);

      return NextResponse.json({ success: true, checkoutUrl: session.url });
    }

    return NextResponse.json({ error: "Unrecognized booking type or missing booking details" }, { status: 400 });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Registration failed. Please try again." },
      { status: 500 }
    );
  }
}
