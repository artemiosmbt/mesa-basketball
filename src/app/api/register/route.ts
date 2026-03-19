import { NextRequest, NextResponse } from "next/server";
import { sendRegistrationNotification } from "@/lib/email";
import {
  addRegistration,
  addRegistrationWithRewards,
  getConfirmedSessionCount,
  getReferralCredits,
  addReferralCredit,
  isNewFamily,
  findReferrerByCode,
  generateReferralCode,
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
      skipEmail,
      emailOnly,
      submittedReferralCode,
    } = body;

    if (!parentName || !email || !phone || !kids || !type || !sessionDetails) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const isPrivateType = type === "private" || type === "group-private";
    let manageToken: string | undefined;
    let isFree = false;
    const referralCode = generateReferralCode(parentName);

    // Save to Supabase (unless this is an email-only request)
    if (!emailOnly) {
      // Check rewards eligibility for private/group-private sessions
      if (isPrivateType) {
        const sessionCount = await getConfirmedSessionCount(email);
        const credits = await getReferralCredits(email);
        // "Effective" sessions = paid sessions + referral credits
        // Free session triggers every 11th effective session (i.e., after 10 paid-equivalent)
        const effectiveCount = sessionCount + credits;
        // The NEXT session (the one being booked now) will be number effectiveCount + 1
        // It's free if (effectiveCount + 1) is a multiple of 11 (i.e., the 11th, 22nd, etc.)
        if ((effectiveCount + 1) % 11 === 0 && effectiveCount + 1 >= 11) {
          isFree = true;
        }
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
        referralCode,
        isFree,
      });
      manageToken = result.manageToken;

      // Handle referral: if a new family used a valid referral code
      if (submittedReferralCode && isPrivateType) {
        const newFamily = await isNewFamily(email);
        // isNewFamily checked BEFORE insert, but we just inserted — so check count = 1
        // Actually we already inserted, so "new" means they had 0 before this one = count is now 1
        // Re-check: the insert already happened, so count is at least 1. We need to check if they had 0 before.
        // Since we can't undo, let's just check count <= 1 (this is their first)
        const sessionCount = await getConfirmedSessionCount(email);
        if (sessionCount <= 1) {
          const referrerEmail = await findReferrerByCode(submittedReferralCode);
          if (referrerEmail && referrerEmail !== email) {
            // Credit both the referrer and the new family
            await addReferralCredit(referrerEmail);
            await addReferralCredit(email);
          }
        }
      }
    }

    // Send emails (unless this registration should skip email)
    if (!skipEmail) {
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
        referralCode: isPrivateType ? referralCode : undefined,
      });
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
