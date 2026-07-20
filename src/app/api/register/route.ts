import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { SERVICE_FEE } from "@/lib/pricing";
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
  checkDuplicateRegistration,
  getAccountCreditBalance,
  deductAccountCredit,
  attachStripeCheckoutSession,
  getActivePackage,
  countPackageSessionsUsed,
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
      email,
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
      // Weekly multi-session fields
      weeklySessions,
      weeklyTotalPrice,
      // Camp multi-day fields
      campSessions,
      campTotalPrice,
      campTotalDays,
      campDropInRate,
      // Recurring private multi-date fields — one row per date, one Stripe
      // charge for the total (see the branch below).
      privateSessions,
      // Referral credit opt-in
      useReferralCredit,
      // Account credit opt-in (dollar-value credit from e.g. a partial camp cancellation)
      applyAccountCredit,
    } = body;

    if (!parentName || !email || !phone || !kids || !type || !sessionDetails) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
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
          if (info && info.email !== email) {
            weeklyReferrer = info;
          }
        }
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

      // Create one registration row per selected session
      // Use weeklyTotalPrice / session count to capture any multi-session volume discounts
      const perSessionPrice = weeklyTotalPrice && weeklySessions.length > 0
        ? Math.round(weeklyTotalPrice / weeklySessions.length)
        : (weeklySessions[0]?.price ? weeklySessions[0].price * (totalParticipants || 1) : undefined);

      // Account credit is applied once, against the first session's row only —
      // same convention as referral credit on recurring private bookings.
      let weeklyCreditApplied = 0;
      if (applyAccountCredit && perSessionPrice != null) {
        const balance = await getAccountCreditBalance(email);
        weeklyCreditApplied = Math.min(balance, perSessionPrice);
        if (weeklyCreditApplied > 0) await deductAccountCredit(email, weeklyCreditApplied);
      }

      const weeklyTotal = weeklyTotalPrice ?? (perSessionPrice != null ? perSessionPrice * weeklySessions.length : 0);
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
          sessionPrice: perSessionPrice,
          ...(i === 0 && weeklyCreditApplied > 0 ? { appliedAccountCredit: weeklyCreditApplied } : {}),
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
        weeklyTotalPrice,
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
      const isPickupBooking = weeklySessions[0]?.group?.toLowerCase().includes("pickup");
      const groupLabel = weeklySessions[0]?.group || (isPickupBooking ? "Pickup" : "Group");
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_creation: "always",
        customer_email: email,
        client_reference_id: bookingBatchId,
        metadata: {
          booking_batch_id: bookingBatchId,
          referrer_email: weeklyReferrer?.email || "",
          referrer_name: weeklyReferrer?.name || "",
          submitted_referral_code: submittedReferralCode || "",
          total_price: String(weeklyTotal),
        },
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: `${groupLabel} — ${weeklySessions.length} session${weeklySessions.length !== 1 ? "s" : ""}` },
              unit_amount: Math.round(amountToCharge * 100),
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

    // Handle camp multi-day registration
    if (type === "camp" && campSessions && campSessions.length > 0) {
      const referralCode = await generateUniqueReferralCode(parentName, email);

      // Check referral BEFORE saving (isNewClient returns false after registration is stored)
      let campReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode) {
        const newClient = await isNewClient(email, phone);
        if (newClient) {
          const info = await findReferrerInfoByCode(submittedReferralCode);
          if (info && info.email !== email) {
            campReferrer = info;
          }
        }
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

      // A camp booking always has a real price — if it's ever missing or
      // unparseable, reject rather than silently letting amountToCharge fall
      // to 0 and confirming a paid camp for free.
      if (!campTotalPrice) {
        return NextResponse.json({ error: "Missing camp price" }, { status: 400 });
      }
      // Parse total price string (e.g. "$290" or "$290 (Early Bird)") to a number
      const campTotalNum = parseInt(String(campTotalPrice).replace(/\D/g, "")) || 0;
      if (campTotalNum <= 0) {
        return NextResponse.json({ error: "Invalid camp price" }, { status: 400 });
      }

      // Determine if this is a full camp purchase or drop-in days
      // campSessions comes from the selected days; we need the total available days to compare.
      // The frontend passes campTotalDays alongside campSessions for this check.
      const isFullCamp = campTotalDays != null
        ? campSessions.length === campTotalDays
        : false;

      // Splits `total` across `days` so every day's share sums EXACTLY back to
      // the total — Math.round(total/days) applied identically to every day
      // can round the same way on every row (e.g. $11 over 2 days -> $6 and
      // $6), and since each drop-in day is later refunded independently,
      // that would let cumulative refunds exceed what was actually charged.
      function dropInDayPrice(index: number, total: number, days: number): number {
        return Math.round((total * (index + 1)) / days) - Math.round((total * index) / days);
      }

      // Full camp: every row stores the SAME total price (the per-day
      // cancellation cap math and the 50% full-cancel fee both need every row
      // in the group to agree on the same "original" price). Drop-in: each
      // day gets its own share via the exact split above.
      const firstDayPrice = isFullCamp ? campTotalNum : dropInDayPrice(0, campTotalNum, campSessions.length);

      // Account credit is applied once, against the first day's row only —
      // never against the full total, since every row in a full-camp group
      // must agree on the same "original" price for the per-day-cancellation
      // cap math.
      let campCreditApplied = 0;
      if (applyAccountCredit) {
        const balance = await getAccountCreditBalance(email);
        campCreditApplied = Math.min(balance, firstDayPrice);
        if (campCreditApplied > 0) await deductAccountCredit(email, campCreditApplied);
      }

      const amountToCharge = Math.max(0, campTotalNum - campCreditApplied);
      const bookingBatchId = crypto.randomUUID();

      for (const [i, session] of campSessions.entries()) {
        const dayPrice = isFullCamp ? campTotalNum : dropInDayPrice(i, campTotalNum, campSessions.length);
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
          ...(isFullCamp && campDropInRate != null ? { campDropInRate: parseInt(String(campDropInRate)) || undefined } : {}),
          ...(i === 0 && campCreditApplied > 0 ? { appliedAccountCredit: campCreditApplied } : {}),
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
        campTotalPrice: campTotalPrice ? String(campTotalPrice) : undefined,
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
        customer_email: email,
        client_reference_id: bookingBatchId,
        metadata: {
          booking_batch_id: bookingBatchId,
          referrer_email: campReferrer?.email || "",
          referrer_name: campReferrer?.name || "",
          submitted_referral_code: submittedReferralCode || "",
          total_price: campTotalPrice ? String(campTotalPrice) : "",
          camp_grade_group: firstSession.gradeGroup || "",
        },
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: `${campNameLine} — ${campSessions.length} day${campSessions.length !== 1 ? "s" : ""}` },
              unit_amount: Math.round(amountToCharge * 100),
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
      const rate = kidCount >= 4 ? 250 : 150;
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
        if (info && info.email !== email) {
          privateReferrer = info;
        }
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
        const effectivePrice = packageCovered ? 0 : isFree ? Math.round(fullPrice * 0.5) : fullPrice;
        return { ...s, fullPrice, effectivePrice, isFree, packageCovered, packageId };
      });

      const totalBeforeCredit = pricedSessions.reduce((sum: number, s: { effectivePrice: number }) => sum + s.effectivePrice, 0);

      // Account credit is applied once, against the series total (recorded
      // on the first date's row) — same convention as weekly/camp.
      let accountCreditApplied = 0;
      if (applyAccountCredit && totalBeforeCredit > 0) {
        const balance = await getAccountCreditBalance(email);
        accountCreditApplied = Math.min(balance, totalBeforeCredit);
        if (accountCreditApplied > 0) await deductAccountCredit(email, accountCreditApplied);
      }

      const amountToCharge = Math.max(0, totalBeforeCredit - accountCreditApplied);
      const bookingBatchId = crypto.randomUUID();

      for (const [i, s] of pricedSessions.entries()) {
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
          ...(i === 0 && accountCreditApplied > 0 ? { appliedAccountCredit: accountCreditApplied } : {}),
          status: amountToCharge > 0 ? "pending_payment" : undefined,
          bookingBatchId,
          ...(s.packageId ? { packageId: s.packageId } : {}),
        });
      }

      const seriesFinalizeParams = {
        parentName,
        email,
        phone,
        kids,
        type,
        privateSessions: pricedSessions as Array<{ date: string; startTime: string; endTime: string; location: string; trainer?: string; fullPrice: number; isFree: boolean; packageCovered?: boolean }>,
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
        customer_email: email,
        client_reference_id: bookingBatchId,
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
              product_data: { name: `${pricedSessions.length} private session${pricedSessions.length !== 1 ? "s" : ""}` },
              unit_amount: Math.round(amountToCharge * 100),
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

    // Single-date private/group-private booking, paid via Stripe.
    if (isPrivateType && !privateSessions) {
      if (!bookedDate || !bookedStartTime || !bookedEndTime || !bookedLocation) {
        return NextResponse.json({ error: "Missing session details" }, { status: 400 });
      }

      const newClient = await isNewClient(email, phone);
      let privateReferrer: { email: string; name: string } | null = null;
      if (submittedReferralCode && newClient) {
        const info = await findReferrerInfoByCode(submittedReferralCode);
        if (info && info.email !== email) {
          privateReferrer = info;
        }
      }

      // Already covered by an active monthly package? Check this before any
      // discount/credit logic — a package-covered session is already fully
      // prepaid, so it shouldn't also spend a referral credit or "waste" the
      // first-time discount that could instead apply to a future session.
      const { covered: packageCovered, packageId } = (await allocatePackageCoverage(email, [bookedDate], totalParticipants || 1))[0];

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

      let accountCreditApplied = 0;
      if (!packageCovered && applyAccountCredit && privateSessionPrice != null) {
        const balance = await getAccountCreditBalance(email);
        accountCreditApplied = Math.min(balance, privateSessionPrice);
        if (accountCreditApplied > 0) await deductAccountCredit(email, accountCreditApplied);
      }

      const effectivePrice = packageCovered
        ? 0
        : isFree && privateSessionPrice != null
          ? Math.round(privateSessionPrice * 0.5)
          : (privateSessionPrice ?? 0);
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
        customer_email: email,
        client_reference_id: bookingBatchId,
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
              unit_amount: Math.round(amountToCharge * 100),
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
