/**
 * Temporary promo toggles. Both promos are fully built and wired up — set
 * back to `true` (no other code changes needed) to resume offering them.
 */

// New clients' first private session at 50% off.
export const NEW_CLIENT_DISCOUNT_ENABLED = false;

// Refer-a-friend program: entering a new referral code (either as the new
// client or on a package) and earning new credits by referring someone.
// Redeeming an already-earned credit is governed separately below — this
// flag alone controls whether NEW credits can be created.
export const REFERRAL_PROGRAM_ENABLED = false;

// Spending an already-earned referral credit for a half-off ($75 flat)
// session. Only a handful of clients have any balance left (no new ones can
// be earned while REFERRAL_PROGRAM_ENABLED is off above), and decrementReferralCredit
// only ever touches an account with credits > 0 regardless of this flag, so
// turning this on doesn't let anyone new into the program — it just lets
// existing balances still be spent. Flip off too if those should stop being
// redeemable as well.
export const REFERRAL_CREDIT_REDEMPTION_ENABLED = true;

// Whether Artemios himself is currently taking new monthly-package
// enrollments (he's still shown as an option, just grayed out/disabled,
// while this is false — e.g. while he's traveling and part-time trainers
// are covering privates). Flip to true when he's back. This only gates the
// PACKAGE tier selector — individual private-session slots are entirely
// driven by whether he actually has rows in the schedule sheet, no flag
// needed there.
export const ARTEMIOS_PACKAGES_AVAILABLE = false;
