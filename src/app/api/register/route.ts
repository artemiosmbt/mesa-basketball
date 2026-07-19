import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification, sendReferralCreditNotification } from "@/lib/email";
import { addPrivateSessionToCalendar } from "@/lib/calendar";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
import { getStripe } from "@/lib/stripe";
import { finalizeConfirmedPrivateBooking, finalizeConfirmedWeeklyBooking, finalizeConfirmedCampBooking } from "@/lib/booking-finalize";
import {
  addRegistrationWithRewards,
  isNewClient,
  getReferralCredits,
  decrementReferralCredit,
  addReferralCredit,
  findReferrerByCode,
  findReferrerInfoByCode,
  generateUniqueReferralCode,
  checkGroupSessionCapacity,
  checkDuplicateRegistration,
  getActivePackage,
  setPackageSessions,
  countConfirmedPrivateSessions,
  getAccountCreditBalance,
  deductAccountCredit,
  attachStripeCheckoutSession,
} from "@/lib/supabase";

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
      skipEmail,
      emailOnly,
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
      // Referral credit opt-in
      useReferralCredit,
      // Account credit opt-in (dollar-value credit from e.g. a partial camp cancellation)
      applyAccountCredit,
      // Set by the frontend on the consolidated emailOnly call for a recurring private
      // series, echoing back whether the first dated call actually applied the referral
      // — that call is the only one where isNewClient can still be true, so it's the
      // only one that can know for sure.
      referralWasApplied,
      // True when this private/group-private call is one leg of a multi-date
      // recurring booking (datesToBook.length > 1 on the frontend). Recurring
      // bookings make several separate calls today, which doesn't map onto a
      // single Stripe Checkout Session — they keep the pre-Stripe flow until
      // that's consolidated into one batched call.
      isRecurring,
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

      // Parse total price string (e.g. "$290" or "$290 (Early Bird)") to a number
      const campTotalNum = campTotalPrice ? parseInt(String(campTotalPrice).replace(/\D/g, "")) || 0 : 0;

      // Determine if this is a full camp purchase or drop-in days
      // campSessions comes from the selected days; we need the total available days to compare.
      // The frontend passes campTotalDays alongside campSessions for this check.
      const isFullCamp = campTotalDays != null
        ? campSessions.length === campTotalDays
        : false;

      // Full camp: store total price paid (for 50% fee on full cancel).
      // Drop-in: store per-day price (for 50% fee on individual day cancel).
      const sessionPrice = campTotalNum > 0
        ? isFullCamp
          ? campTotalNum
          : Math.round(campTotalNum / campSessions.length)
        : undefined;

      // Account credit is applied once, against the first day's row only — never
      // against sessionPrice itself, since every row in a full-camp group must
      // agree on the same "original" price for the per-day-cancellation cap math.
      let campCreditApplied = 0;
      if (applyAccountCredit && sessionPrice != null) {
        const balance = await getAccountCreditBalance(email);
        campCreditApplied = Math.min(balance, sessionPrice);
        if (campCreditApplied > 0) await deductAccountCredit(email, campCreditApplied);
      }

      const amountToCharge = Math.max(0, campTotalNum - campCreditApplied);
      const bookingBatchId = crypto.randomUUID();

      for (const [i, session] of campSessions.entries()) {
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
          sessionPrice,
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
        campCreditApplied,
        sessionPrice,
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

    // Single-date private/group-private booking, paid via Stripe. Recurring
    // bookings (isRecurring) and the emailOnly consolidated-email call for a
    // recurring series fall through to the pre-Stripe flow below unchanged —
    // see the comment on `isRecurring` above for why.
    if (isPrivateType && !emailOnly && !isRecurring) {
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

      let isFree = false;
      let isFirstTime = false;
      let usedReferralCredit = false;
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

      const privateSessionPrice = calcPrivateSessionPrice(bookedStartTime, bookedEndTime, totalParticipants || 1);

      let accountCreditApplied = 0;
      if (applyAccountCredit && privateSessionPrice != null) {
        const balance = await getAccountCreditBalance(email);
        accountCreditApplied = Math.min(balance, privateSessionPrice);
        if (accountCreditApplied > 0) await deductAccountCredit(email, accountCreditApplied);
      }

      const effectivePrice = isFree && privateSessionPrice != null
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
        ],
        success_url: `${origin}/booking-confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/schedule?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      });

      await attachStripeCheckoutSession(bookingBatchId, session.id);

      return NextResponse.json({ success: true, checkoutUrl: session.url });
    }

    let manageToken: string | undefined;
    let isFree = false;
    let isFirstTime = false;
    let usedReferralCredit = false;
    let packageSessionsRemaining: number | undefined;
    let packageType: number | undefined;
    let accountCreditApplied = 0;
    let privateSessionPrice: number | undefined;
    let privateReferrer: { email: string; name: string } | null = null;

    // Save to Supabase (unless this is an email-only request)
    if (!emailOnly) {
      // Check new-client status and referral BEFORE saving
      const newClient = await isNewClient(email, phone);
      if (submittedReferralCode && newClient) {
        const info = await findReferrerInfoByCode(submittedReferralCode);
        if (info && info.email !== email) {
          privateReferrer = info;
        }
      }

      // Check first-time discount and referral credit
      if (isPrivateType) {
        if (newClient) {
          isFree = true; // first-time 50% off
          isFirstTime = true;
        } else if (useReferralCredit) {
          // User explicitly chose to apply a credit
          const credits = await getReferralCredits(email);
          if (credits > 0) {
            isFree = true;
            usedReferralCredit = true;
            await decrementReferralCredit(email);
          }
        }
      }

      privateSessionPrice = isPrivateType
        ? calcPrivateSessionPrice(bookedStartTime, bookedEndTime, totalParticipants || 1)
        : undefined;

      // Account credit is applied against the full computed price, same as the
      // camp/weekly branches — never against a discounted amount, matching how
      // isFree's 50% off is also always computed at display time, not stored here.
      if (isPrivateType && applyAccountCredit && privateSessionPrice != null) {
        const balance = await getAccountCreditBalance(email);
        accountCreditApplied = Math.min(balance, privateSessionPrice);
        if (accountCreditApplied > 0) await deductAccountCredit(email, accountCreditApplied);
      }

      const result = await addRegistrationWithRewards({
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
      });
      manageToken = result.manageToken;

      // If booking a private session with a booked_date, check for active package
      if (isPrivateType && bookedDate && !emailOnly) {
        const d = new Date(bookedDate);
        const bookingMonth = isNaN(d.getTime())
          ? null
          : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const activePkg = bookingMonth ? await getActivePackage(email, bookingMonth) : null;
        if (activePkg && bookingMonth) {
          const confirmedCount = await countConfirmedPrivateSessions(email, bookingMonth);
          const newUsed = Math.min(activePkg.package_type, confirmedCount);
          await setPackageSessions(activePkg.id, newUsed);
          if (newUsed <= activePkg.package_type) {
            packageSessionsRemaining = activePkg.package_type - newUsed;
            packageType = activePkg.package_type;
          }
        }
      }

      // Award referral credit to referrer and notify them. Best-effort — the booking
      // above already succeeded, so a failure here must not surface as a failed
      // registration to the client (they'd retry and double-book).
      if (privateReferrer) {
        try {
          await addReferralCredit(privateReferrer.email);
          await sendReferralCreditNotification({ referrerName: privateReferrer.name, referrerEmail: privateReferrer.email, newClientName: parentName });
        } catch (creditErr) {
          console.error("Failed to award referral credit (private, booking was saved):", creditErr);
        }
      }
    }

    // Send emails (unless this registration should skip email)
    if (!skipEmail) {
      // For emailOnly consolidated recurring: look up active package to get remaining count
      let effectivePkgRemaining = packageSessionsRemaining;
      let effectivePkgType = packageType;
      if (emailOnly && isPrivateType) {
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const activePkg = await getActivePackage(email, currentMonth).catch(() => null);
        if (activePkg) {
          effectivePkgRemaining = activePkg.package_type - activePkg.sessions_used;
          effectivePkgType = activePkg.package_type;
        }
      }

      try {
        await sendRegistrationNotification({
          parentName,
          email,
          phone,
          kids,
          type,
          sessionDetails,
          totalParticipants: totalParticipants || 1,
          manageToken,
          isFree,
          isFirstTime,
          packageSessionsRemaining: effectivePkgRemaining,
          packageType: effectivePkgType,
          referralCode,
          referredBy: privateReferrer?.name,
          referralCodeUsed: submittedReferralCode || undefined,
          trainer: isPrivateType ? bookedTrainer : undefined,
          calendarEvent: bookedDate && bookedStartTime ? { date: bookedDate, startTime: bookedStartTime, endTime: bookedEndTime || bookedStartTime, location: bookedLocation || "" } : undefined,
          accountCreditApplied,
          fullPrice: privateSessionPrice,
        });
      } catch (notifyErr) {
        console.error("Private booking email failed (booking was saved):", notifyErr);
      }

      // SMS runs independently so it always fires even if email throws.
      // Also fires for emailOnly consolidated recurring calls (no bookedDate).
      if (smsConsent && phone) {
        const isSingle = !!bookedDate;
        const typeStr = isSingle ? (isPrivateType ? "private session" : "session") : "sessions";
        const verbStr = isSingle ? "is" : "are";
        const dateLine = isSingle
          ? `\n${formatDateWithDay(bookedDate!)} | ${bookedStartTime}${bookedEndTime ? `-${bookedEndTime}` : ""}${bookedLocation ? `\nLocation: ${resolveLocationName(bookedLocation)}` : ""}`
          : `\n${sessionDetails.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim()}`;
        const pkgNote = effectivePkgRemaining !== undefined
          ? `\n${effectivePkgRemaining} session${effectivePkgRemaining !== 1 ? "s" : ""} remaining in your package.`
          : "";
        const privateTrainerLine = isPrivateType && bookedTrainer ? `\nTrainer: ${bookedTrainer}` : "";
        const creditLine = accountCreditApplied > 0 ? `\n$${accountCreditApplied} account credit applied.` : "";
        await sendSMS(phone, `Mesa Basketball: Your ${typeStr} ${verbStr} confirmed!${dateLine}${privateTrainerLine}${pkgNote}${creditLine}\nAthlete: ${kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
      }
      const adminDateLine = bookedDate
        ? `${formatDateWithDay(bookedDate)} | ${bookedStartTime}${bookedEndTime ? `-${bookedEndTime}` : ""}${bookedLocation ? `\nLocation: ${resolveLocationName(bookedLocation)}` : ""}`
        : sessionDetails.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
      const pkgAdminNote = effectivePkgRemaining !== undefined
        ? `\nPkg: ${effectivePkgRemaining}/${effectivePkgType} remaining`
        : "";
      const adminTrainerLine = isPrivateType && bookedTrainer ? `\nTrainer: ${bookedTrainer}` : "";
      // Match the pickup/group/camp texts' "N x session(s):" header so the admin always
      // sees the session type up front instead of jumping straight to the date.
      const adminTypeLabel = type === "group-private" ? "group private" : "private";
      const adminTypeHeader = bookedDate ? `1 ${adminTypeLabel} session:` : `${adminTypeLabel} sessions:`;
      // emailOnly consolidated calls (recurring series) never compute privateReferrer
      // themselves — isNewClient is already false by then — so trust the flag echoed
      // back from the first dated call instead.
      const referralWasAppliedForSms = emailOnly ? !!referralWasApplied : !!privateReferrer;
      await sendAdminSMS(`NEW BOOKING: ${parentName}\n${adminTypeHeader}\n${adminDateLine}${adminTrainerLine}\nPlayers: ${kids}${pkgAdminNote}${submittedReferralCode ? `\nRef code: ${submittedReferralCode} ${referralWasAppliedForSms ? "✓ applied" : "✗ NOT applied"}` : ""}`);
    }

    // Add to Google Calendar (private sessions only; group/camp handled above)
    if (!emailOnly && bookedDate && bookedStartTime && bookedEndTime) {
      if (isPrivateType) {
        try {
          await addPrivateSessionToCalendar({
            parentName,
            email,
            phone,
            kids,
            bookedDate,
            bookedStartTime,
            bookedEndTime,
            bookedLocation: bookedLocation || "",
            trainer: bookedTrainer || undefined,
          });
        } catch (err) {
          console.error("Calendar sync error (private):", err);
        }
      }
    }

    return NextResponse.json({ success: true, isFree, referralApplied: !!privateReferrer });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Registration failed. Please try again." },
      { status: 500 }
    );
  }
}
