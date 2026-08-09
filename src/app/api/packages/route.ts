import { NextRequest, NextResponse } from "next/server";
import { enrollInPackage, getActivePackage, hasPendingOrActivePackage, isNewClient, findReferrerInfoByCode, attachPackageCheckoutSession, getAccountCreditBalance, deductAccountCredit, addAccountCredit } from "@/lib/supabase";
import { getStripe, buildCreditDiscount } from "@/lib/stripe";
import { calcServiceFee, serviceFeeItemName, packagePrice, type TrainerTier } from "@/lib/pricing";
import { resolveRequestEmail } from "@/lib/request-email";
import { finalizePaidPackageEnrollment } from "@/lib/booking-finalize";
import { ARTEMIOS_PACKAGES_AVAILABLE } from "@/lib/feature-flags";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { parentName, email: rawEmail, phone, packageType, monthYear, kids, referralCode, smsConsent, applyAccountCredit: rawApplyAccountCredit, trainerTier: rawTrainerTier } = body;
    // Never trust a client-sent price for this — only the tier selection
    // itself, validated against a fixed set, with price always computed
    // server-side from it (see packagePrice below).
    const trainerTier: TrainerTier = rawTrainerTier === "other" ? "other" : "artemios";
    // Normalized once at the boundary — the self-referral comparison below
    // must match the lowercased/trimmed form already stored for the referrer.
    const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : rawEmail;

    // Account credit belongs to a real logged-in identity — never trust the
    // client-supplied email alone to decide whose balance gets spent, or
    // anyone who knows a client's email could drain their credit onto a
    // package that isn't theirs. Only the caller's OWN authenticated session
    // can authorize spending its balance; a guest with no session can never
    // apply credit, since it can't prove ownership of any balance at all.
    const sessionEmail = await resolveRequestEmail(req);
    const applyAccountCredit = !!rawApplyAccountCredit && !!sessionEmail && sessionEmail === email;

    if (!parentName || !email || !phone || !packageType || !monthYear) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (packageType !== 4 && packageType !== 8) {
      return NextResponse.json({ error: "Invalid package type. Must be 4 or 8." }, { status: 400 });
    }

    // The client-side selector disables the Artemios option while he's not
    // taking new package enrollments — enforce that here too, not just
    // visually, since a request can always be sent directly regardless of
    // what the UI shows.
    if (trainerTier === "artemios" && !ARTEMIOS_PACKAGES_AVAILABLE) {
      return NextResponse.json({ error: "Artemios isn't currently taking new package enrollments. Please choose Any Available Trainer instead." }, { status: 400 });
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
        if (info && info.email.toLowerCase().trim() !== email) {
          referrer = info;
        }
      }
    }

    const totalPrice = packagePrice(packageType, trainerTier);

    // Same account-credit pattern as every other paid booking type
    // (/api/register): deduct up front, race-safe, capped at the price
    // itself so a balance bigger than the package can't go negative.
    let accountCreditApplied = 0;
    if (applyAccountCredit && totalPrice > 0) {
      const balance = await getAccountCreditBalance(email);
      const wantCredit = Math.min(balance, totalPrice);
      if (wantCredit > 0) {
        const deducted = await deductAccountCredit(email, wantCredit);
        if (deducted) accountCreditApplied = wantCredit;
      }
    }
    const amountToCharge = Math.max(0, totalPrice - accountCreditApplied);

    let id: string;
    try {
      ({ id } = await enrollInPackage({
        email, parentName, phone, packageType, monthYear, totalPrice, trainerTier,
        ...(accountCreditApplied > 0 ? { appliedAccountCredit: accountCreditApplied } : {}),
      }));
    } catch (err) {
      // Credit was already deducted above — if the package row itself
      // failed to create, that credit must come straight back rather than
      // vanishing with nothing to show for it.
      if (accountCreditApplied > 0) {
        await addAccountCredit(email, accountCreditApplied).catch((refundErr) =>
          console.error(`Failed to refund $${accountCreditApplied} credit after enrollInPackage failure for ${email}:`, refundErr)
        );
      }
      throw err;
    }

    const packageMetadata = {
      purpose: "package_enrollment",
      package_id: id,
      kids: kids || "",
      sms_consent: String(!!smsConsent),
      referrer_email: referrer?.email || "",
      referrer_name: referrer?.name || "",
      submitted_referral_code: referralCode || "",
    };

    if (amountToCharge === 0) {
      // Fully covered by account credit — nothing to actually charge, so
      // confirm immediately exactly like the equivalent register/route.ts
      // path does for a $0 private-session booking.
      await finalizePaidPackageEnrollment(id, "", null, packageMetadata);
      return NextResponse.json({ success: true });
    }

    // Real money is still due — send them to Stripe. The package stays
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
      discounts: await buildCreditDiscount(stripe, accountCreditApplied),
      // The webhook runs in a separate request with no access to this
      // request's body, and monthly_packages has no columns for kids/SMS
      // consent — small facts the finalize step needs ride along here.
      metadata: packageMetadata,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `${packageType}-Session Monthly Package (${trainerTier === "other" ? "Any Available Trainer" : "Artemios"}) — ${monthYear}` },
            // Full pre-credit price — the discount coupon above handles the
            // credit deduction as its own line on Stripe's own page.
            unit_amount: Math.round(totalPrice * 100),
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: "usd",
            product_data: { name: serviceFeeItemName(amountToCharge) },
            unit_amount: Math.round(calcServiceFee(amountToCharge) * 100),
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
