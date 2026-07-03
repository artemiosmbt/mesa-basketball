import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification, sendReferralCreditNotification } from "@/lib/email";
import { addPrivateSessionToCalendar, upsertGroupSessionCalendarEvent } from "@/lib/calendar";
import { sendSMS, sendAdminSMS, formatDateWithDay, resolveLocationName } from "@/lib/sms";
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
        });
      }

      // Send ONE consolidated email
      const isPickupBooking = weeklySessions[0]?.group?.toLowerCase().includes("pickup");
      const allSessionsList = weeklySessions
        .map((s: { date: string; startTime: string; endTime: string; location: string }) =>
          `${s.date} ${s.startTime}-${s.endTime} at ${s.location}`
        )
        .join("<br/>");

      const priceNote = weeklyTotalPrice
        ? weeklyCreditApplied > 0
          ? `<p><strong>Total:</strong> $${weeklyTotalPrice} — $${weeklyCreditApplied} account credit applied — <strong>Due:</strong> $${weeklyTotalPrice - weeklyCreditApplied}</p>`
          : `<p><strong>Total:</strong> $${weeklyTotalPrice}</p>`
        : "";

      try {
        await sendRegistrationNotification({
          parentName,
          email,
          phone,
          kids,
          type: "weekly",
          sessionDetails: `${isPickupBooking ? "Pickup" : "Group"} Session${weeklySessions.length !== 1 ? "s" : ""} (${weeklySessions.length} ${weeklySessions.length !== 1 ? "dates" : "date"}):<br/>${allSessionsList}${priceNote ? "<br/>" + priceNote : ""}`,
          totalParticipants: totalParticipants || 1,
          referralCode,
          referredBy: weeklyReferrer?.name,
          referralCodeUsed: submittedReferralCode || undefined,
          trainer: weeklySessions[0]?.trainer,
          calendarEvent: weeklySessions[0] ? { date: weeklySessions[0].date, startTime: weeklySessions[0].startTime, endTime: weeklySessions[0].endTime, location: weeklySessions[0].location } : undefined,
        });

        if (weeklyReferrer) {
          await addReferralCredit(weeklyReferrer.email);
          await sendReferralCreditNotification({ referrerName: weeklyReferrer.name, referrerEmail: weeklyReferrer.email, newClientName: parentName });
        }
      } catch (notifyErr) {
        console.error("Weekly booking email failed (booking was saved):", notifyErr);
      }

      // SMS runs independently so it always fires even if email throws
      const sessionTypeSMS = isPickupBooking ? "pickup session" : "session";
      const weeklyTrainerLine = weeklySessions[0]?.trainer ? `\nTrainer: ${weeklySessions[0].trainer}` : "";
      if (smsConsent) {
        const sessionLines = weeklySessions.map((s: { date: string; startTime: string; endTime: string; location: string }) =>
          `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}`
        ).join("\n");
        const count = weeklySessions.length;
        const confirmLabel = count === 1 ? `${isPickupBooking ? "Pickup session" : "Session"}` : `${count} ${isPickupBooking ? "pickup sessions" : "sessions"}`;
        const creditLine = weeklyCreditApplied > 0 ? `\n$${weeklyCreditApplied} account credit applied.` : "";
        await sendSMS(phone, `Mesa Basketball: ${confirmLabel} confirmed!\n${sessionLines}${weeklyTrainerLine}\nAthlete: ${kids}${creditLine}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
      }
      const adminLines = weeklySessions.map((s: { date: string; startTime: string; endTime: string; location: string }) =>
        `${formatDateWithDay(s.date)} | ${s.startTime}-${s.endTime}\nLocation: ${resolveLocationName(s.location)}`
      ).join("\n");
      await sendAdminSMS(`NEW BOOKING: ${parentName}\n${weeklySessions.length} ${sessionTypeSMS}${weeklySessions.length !== 1 ? "s" : ""}:\n${adminLines}${weeklyTrainerLine}\nPlayers: ${kids}${submittedReferralCode ? `\nRef code: ${submittedReferralCode}` : ""}`);

      // Update Google Calendar for each weekly session
      for (const session of weeklySessions) {
        try {
          await upsertGroupSessionCalendarEvent({
            sessionType: "weekly",
            sessionLabel: session.group || "Group Session",
            bookedDate: session.date,
            bookedStartTime: session.startTime,
            bookedEndTime: session.endTime,
            bookedLocation: session.location,
            maxSpots: session.maxSpots,
            kidsJustRegistered: kids,
            participantsJustRegistered: totalParticipants || 1,
          });
        } catch (err) {
          console.error("Calendar sync error (weekly):", err);
        }
      }

      return NextResponse.json({ success: true, count: weeklySessions.length });
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
        });
      }

      const daysList = campSessions
        .map((s: { date: string; startTime: string; endTime: string }) => `${s.date} ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}`)
        .join("<br/>");
      const priceNote = campTotalPrice
        ? campCreditApplied > 0
          ? `<br/><strong>Total:</strong> ${campTotalPrice} — $${campCreditApplied} account credit applied — <strong>Due:</strong> $${(sessionPrice ?? 0) - campCreditApplied}`
          : `<br/><strong>Total:</strong> ${campTotalPrice}`
        : "";
      const firstSession = campSessions[0];

      try {
        await sendRegistrationNotification({
          parentName,
          email,
          phone,
          kids,
          type: "camp",
          sessionDetails: `${firstSession.campName}${firstSession.gradeGroup ? ` — ${firstSession.gradeGroup}` : ""}<br/>Days registered (${campSessions.length}):<br/>${daysList}${priceNote}`,
          totalParticipants: totalParticipants || 1,
          referralCode,
          referredBy: campReferrer?.name,
          referralCodeUsed: submittedReferralCode || undefined,
          calendarEvent: { date: firstSession.date, startTime: firstSession.startTime, endTime: firstSession.endTime || firstSession.startTime, location: firstSession.location },
        });

        if (campReferrer) {
          await addReferralCredit(campReferrer.email);
          await sendReferralCreditNotification({ referrerName: campReferrer.name, referrerEmail: campReferrer.email, newClientName: parentName });
        }
      } catch (notifyErr) {
        console.error("Camp booking email failed (booking was saved):", notifyErr);
      }

      // SMS runs independently so it always fires even if email throws
      if (smsConsent) {
        const campDayLines = campSessions.map((s: { date: string; startTime: string; endTime?: string; location: string }) =>
          `${formatDateWithDay(s.date)} | ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}\nLocation: ${resolveLocationName(s.location)}`
        ).join("\n");
        const priceText = campTotalPrice
          ? campCreditApplied > 0
            ? ` Total: ${campTotalPrice}, $${campCreditApplied} credit applied.`
            : ` Total: ${campTotalPrice}.`
          : "";
        await sendSMS(phone, `Mesa Basketball: Camp confirmed (${campSessions.length} day${campSessions.length !== 1 ? "s" : ""})!${priceText}\n${campDayLines}\nAthlete: ${kids}\nManage: mesabasketballtraining.com/my-bookings\nReply STOP to opt out.`);
      }
      const adminCampLines = campSessions.map((s: { date: string; startTime: string; endTime?: string; location: string }) =>
        `${formatDateWithDay(s.date)} | ${s.startTime}${s.endTime ? `-${s.endTime}` : ""}\nLocation: ${resolveLocationName(s.location)}`
      ).join("\n");
      await sendAdminSMS(`NEW BOOKING: ${parentName}\n${campSessions.length} camp day${campSessions.length !== 1 ? "s" : ""}:\n${adminCampLines}\nPlayers: ${kids}${submittedReferralCode ? `\nRef code: ${submittedReferralCode}` : ""}`);

      // Update Google Calendar for each camp day
      for (const session of campSessions) {
        try {
          await upsertGroupSessionCalendarEvent({
            sessionType: "camp",
            sessionLabel: session.campName || "Camp",
            bookedDate: session.date,
            bookedStartTime: session.startTime,
            bookedEndTime: session.endTime || session.startTime,
            bookedLocation: session.location,
            kidsJustRegistered: kids,
            participantsJustRegistered: totalParticipants || 1,
          });
        } catch (err) {
          console.error("Calendar sync error (camp):", err);
        }
      }

      return NextResponse.json({ success: true, count: campSessions.length });
    }

    const isPrivateType = type === "private" || type === "group-private";

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

    let manageToken: string | undefined;
    let isFree = false;
    let isFirstTime = false;
    let usedReferralCredit = false;
    let packageSessionsRemaining: number | undefined;
    let packageType: number | undefined;
    let accountCreditApplied = 0;
    let privateSessionPrice: number | undefined;
    const referralCode = await generateUniqueReferralCode(parentName, email);
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

      // Award referral credit to referrer and notify them
      if (privateReferrer) {
        await addReferralCredit(privateReferrer.email);
        await sendReferralCreditNotification({ referrerName: privateReferrer.name, referrerEmail: privateReferrer.email, newClientName: parentName });
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
      await sendAdminSMS(`NEW BOOKING: ${parentName}\n${adminDateLine}${adminTrainerLine}\nPlayers: ${kids}${pkgAdminNote}${submittedReferralCode ? `\nRef code: ${submittedReferralCode}` : ""}`);
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

    return NextResponse.json({ success: true, isFree });
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Registration failed. Please try again." },
      { status: 500 }
    );
  }
}
