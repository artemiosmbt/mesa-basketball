import { NextRequest, NextResponse } from "next/server";
import { enrollInPackage, getActivePackage, hasPendingOrActivePackage, isNewClient, findReferrerInfoByCode, attachPackageCheckoutSession } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { SERVICE_FEE, packagePrice } from "@/lib/pricing";
import { resolveRequestEmail } from "@/lib/request-email";

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

    // Block a second attempt for the same month whether the existing one is
    // already active or still mid-checkout — otherwise two simultaneous
    // Checkout Sessions could both complete and double-charge.
    const alreadyHasOne = await hasPendingOrActivePackage(email, monthYear);
    if (alreadyHasOne) {
      return NextResponse.json(
        { error: "You already have a package for this month." },
        { status: 400 }
      );
    }

    // Check referrer BEFORE enrolling — same eligibility rule as every other booking type:
    // only a genuinely new client (no prior registration under this email or phone) can
    // trigger a reward for whoever referred them. The actual credit award happens once
    // payment is confirmed (see finalizePaidPackageEnrollment), not here.
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

    const { id } = await enrollInPackage({ email, parentName, phone, packageType, monthYear });

    const totalPrice = packagePrice(packageType);

    // Real money is due — send them to Stripe. The package stays
    // pending_payment (unusable — getActivePackage won't return it) until
    // the webhook confirms payment, same as every other paid booking type.
    const stripe = getStripe();
    const origin = req.nextUrl.origin;
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_creation: "always",
      // Save the card for a legitimate future off-session charge — used
      // when an admin charges a late-reschedule remainder automatically.
      payment_intent_data: { setup_future_usage: "off_session" },
      customer_email: email,
      client_reference_id: id,
      // The webhook runs in a separate request with no access to this
      // request's body, and monthly_packages has no columns for kids/SMS
      // consent — small facts the finalize step needs ride along here.
      metadata: {
        purpose: "package_enrollment",
        package_id: id,
        kids: kids || "",
        sms_consent: String(!!smsConsent),
        referrer_email: referrer?.email || "",
        referrer_name: referrer?.name || "",
        submitted_referral_code: referralCode || "",
      },
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `${packageType}-Session Monthly Package — ${monthYear}` },
            unit_amount: Math.round(totalPrice * 100),
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

    await attachPackageCheckoutSession(id, checkoutSession.id);

    return NextResponse.json({ success: true, checkoutUrl: checkoutSession.url });
  } catch (error) {
    console.error("Package enrollment error:", error);
    return NextResponse.json({ error: "Enrollment failed. Please try again." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const monthYear = req.nextUrl.searchParams.get("monthYear");
    if (!monthYear) {
      return NextResponse.json({ error: "monthYear is required" }, { status: 400 });
    }

    const email = await resolveRequestEmail(req);
    if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const pkg = await getActivePackage(email, monthYear);
    return NextResponse.json({ package: pkg });
  } catch (error) {
    console.error("Package lookup error:", error);
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
}
