/**
 * Temporary promo toggles. Both promos are fully built and wired up — set
 * back to `true` (no other code changes needed) to resume offering them.
 */

// New clients' first private session at 50% off.
export const NEW_CLIENT_DISCOUNT_ENABLED = false;

// Refer-a-friend program: earning new credits by referring, and redeeming
// credits (new or already-earned) at checkout.
export const REFERRAL_PROGRAM_ENABLED = false;

// Whether Artemios himself is currently taking new monthly-package
// enrollments (he's still shown as an option, just grayed out/disabled,
// while this is false — e.g. while he's traveling and part-time trainers
// are covering privates). Flip to true when he's back. This only gates the
// PACKAGE tier selector — individual private-session slots are entirely
// driven by whether he actually has rows in the schedule sheet, no flag
// needed there.
export const ARTEMIOS_PACKAGES_AVAILABLE = false;
