import { NextRequest, NextResponse } from "next/server";
import { enrollInPackage, getActivePackage, countConfirmedPrivateSessions, setPackageSessions, isNewClient, findReferrerInfoByCode, addReferralCredit } from "@/lib/supabase";
import { sendPackageConfirmation, sendReferralCreditNotification } from "@/lib/email";
import { sendSMS, sendAdminSMS } from "@/lib/sms";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { parentName, email, phone, packageType, monthYear, kids, referralCode, smsConsent } = body;

    if (!parentName || !email || !phone || !packageType || !monthYear) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (packageType !== 4 && packageType !== 8) {
      return NextResponse.json({ error: "Invalid package type. Must be 4 or 8." }, { status: 400 });
    }

    // Check if an active package already exists for this email + month
    const existing = await getActivePackage(email, monthYear);
    if (existing) {
      return NextResponse.json(
        { error: "You already have an active package for this month." },
        { status: 400 }
      );
    }

    // Check referrer BEFORE enrolling — same eligibility rule as every other booking type:
    // only a genuinely new client (no prior registration under this email or phone) can
    // trigger a reward for whoever referred them.
    let referrer: { email: string; name: string } | null = null;
    if (referralCode) {
      const newClient = await isNewClient(email, phone);
      if (newClient) {
        const info = await findReferrerInfoByCode(referralCode);
        if (info && info.email !== email) {
          referrer = info;
        }
      }
    }
    const referralApplied = !!referrer;

    const { id } = await enrollInPackage({ email, parentName, phone, packageType, monthYear });

    // Seed sessions_used from any private sessions already booked this month
    const existingCount = await countConfirmedPrivateSessions(email, monthYear);
    if (existingCount > 0) {
      await setPackageSessions(id, Math.min(existingCount, packageType));
    }

    const totalPrice = packageType === 4 ? 475 : 900;

    // Award referral credit unconditionally — must not depend on the confirmation email
    // succeeding below, and wrapped so a failure here (the package is already enrolled)
    // can't surface as a failed enrollment to the client.
    if (referrer) {
      try {
        await addReferralCredit(referrer.email);
        await sendReferralCreditNotification({ referrerName: referrer.name, referrerEmail: referrer.email, newClientName: parentName });
      } catch (creditErr) {
        console.error("Failed to award referral credit (package, enrollment was saved):", creditErr);
      }
    }

    await sendPackageConfirmation({ parentName, email, phone, packageType, monthYear, totalPrice, kids, referralCode });

    if (smsConsent && phone) {
      await sendSMS(phone, `Mesa Basketball: Your ${packageType}-session package is confirmed for ${monthYear}!\nBook your private sessions at mesabasketballtraining.com/schedule and we'll track them automatically.\nReply STOP to opt out.`);
    }
    await sendAdminSMS(`NEW PACKAGE: ${parentName}\n${packageType}-session package — ${monthYear}\nPhone: ${phone}${kids ? `\nPlayers: ${kids}` : ""}${referralCode ? `\nRef code: ${referralCode} ${referralApplied ? "✓ applied" : "✗ NOT applied"}` : ""}`);

    return NextResponse.json({ success: true, id, referralApplied });
  } catch (error) {
    console.error("Package enrollment error:", error);
    return NextResponse.json({ error: "Enrollment failed. Please try again." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const email = searchParams.get("email");
    const monthYear = searchParams.get("monthYear");

    if (!email || !monthYear) {
      return NextResponse.json({ error: "email and monthYear are required" }, { status: 400 });
    }

    const pkg = await getActivePackage(email, monthYear);
    return NextResponse.json({ package: pkg });
  } catch (error) {
    console.error("Package lookup error:", error);
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
}
