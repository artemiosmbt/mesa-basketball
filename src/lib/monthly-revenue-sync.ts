/**
 * Builds/refreshes the "Mesa Monthly Revenue" Google Sheet — a single,
 * human-readable tracker (one tab per month) covering every dollar the
 * company makes, no matter who ran the session: the owner's own sessions,
 * all 5 sub-trainers, and camps. Modeled on the owner's own manual
 * spreadsheet (day rows, sessions listed by name with $ amounts, revenue
 * by location) but with real fee math and trainer-pay tied in.
 *
 * Deliberately a SEPARATE document from the payroll sheet (payroll-sync.ts)
 * — this reads the exact same Supabase data but never touches the payroll
 * sheet's tabs/formulas, so nothing here can ever destabilize payroll.
 *
 * Design: each month's tab is rebuilt from scratch every run — a status
 * change after the fact, a corrected price, etc. just fall out of a fresh
 * rebuild automatically, sidestepping an entire class of incremental-sync
 * bugs. Three exceptions, all real manual input that must survive a rebuild:
 * each month's per-location rent cell (see readExistingRentByName), any
 * day row the owner has hand-edited (see the _DayLog tab / textFingerprint
 * + feeFingerprint below), and the PICKUPS table (columns K:M — cash games
 * the owner runs off-schedule; see buildMonthTab's PICKUPS section) whose
 * data rows this file never issues a write against, so they're untouched
 * by construction rather than needing a fingerprint/lock at all. Session-list text/Place and Processing/Stripe
 * Fee are locked INDEPENDENTLY of each other — a day is only ever
 * text-frozen if its live text/Place diverges from what THIS sync last
 * wrote, and only ever fee-frozen if its live Processing/Stripe diverges
 * from what THIS sync last wrote. They must stay independent: Processing/
 * Stripe legitimately change on their own whenever the underlying booking
 * data does (a participant added after the fact, a price correction), with
 * no owner edit involved at all — bundling that drift into the same lock
 * as the text once meant a routine data change alone could silently freeze
 * a day's whole row forever (a real incident, caught 2026-08-08: Aug 1 got
 * stuck on a stale Processing Fee from early in the month with no owner
 * edit responsible). Gross Revenue (F) and Net Revenue (I) are never
 * independently locked — they're always DERIVED (F = price only, from
 * whatever the text lock decision above resolves to; I = a formula,
 * F+G-H). Month Totals, Trainer Pay's totals, and
 * Location Breakdown are all real Sheets formulas over the day rows /
 * Trainer Pay cells, so they always reflect whatever's actually on the
 * sheet — hand-edited or fresh — with no separate tracking needed. The one
 * remaining DB-only exception is each individual trainer's per-week pay
 * amount in Trainer Pay by Week: there's no per-session cell for it to sum
 * from, so it's always freshly computed, never locked.
 *
 * Trainer pay is computed here in code from the exact rate constants
 * captured live from the payroll sheet's own Settings tab (2026-08-08) —
 * see RATES below — rather than depending on that sheet's formulas, since
 * this is a fully separate document.
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeDate } from "./calendar";
import { parseSessionDateTimeET } from "./booking-finalize";
import { calcServiceFee } from "./pricing";
import { a1Quote, appendValues, batchUpdate, batchUpdateValues, getSheetMeta, getValues, updateValues } from "./sheets-write";
import {
  STRIPE_PCT_CARD,
  STRIPE_FIXED,
  PAYMENT_METHOD_CACHE_TAB,
  MAX_STRIPE_LOOKUPS_PER_RUN,
  ensurePaymentMethodCacheTab,
  readPaymentMethodCache,
  resolveStripePct,
} from "./stripe-payment-method";

export const MONTHLY_REVENUE_SHEET_ID = "1_gSXvi7wXRdLZA2wMuiCwwublyBvUbCMrbJkUnUdaug";
const TRACKER_START_DATE = "2026-08-01";

const SUB_TRAINERS = [
  "Joseph Owens",
  "Zhaneia Thybulle",
  "Steven Papadimitropoulos",
  "Zain Amjad",
] as const;
const OWNER_NAME = "Artemios Gavalas";

type RgbColor = { red: number; green: number; blue: number };

const TRAINER_COLOR: Record<string, RgbColor> = {
  [OWNER_NAME]: { red: 0.1, green: 0.1, blue: 0.1 },
  "Joseph Owens": { red: 0.11, green: 0.31, blue: 0.85 },
  "Zhaneia Thybulle": { red: 0.86, green: 0.15, blue: 0.34 },
  "Steven Papadimitropoulos": { red: 0.13, green: 0.55, blue: 0.25 },
  "Zain Amjad": { red: 0.9, green: 0.5, blue: 0.05 },
};
const CAMP_COLOR: RgbColor = { red: 0.45, green: 0.45, blue: 0.45 };
const HEADER_BG: RgbColor = { red: 0.227, green: 0.153, blue: 0.11 };
const WHITE: RgbColor = { red: 1, green: 1, blue: 1 };

// Rates read live from the payroll sheet's Settings tab (2026-08-08) — see
// conversation for the verification pass. Kept here as plain constants
// (not shared with payroll-sync.ts) since this document intentionally
// doesn't depend on the payroll sheet at all.
const BASE_HOURLY_RATE = 20;
const INCENTIVE_PER_HEAD = 20;
const PRIVATE_TRAINER_RATE_1_3 = 60;
const PRIVATE_TRAINER_RATE_4PLUS = 90;
// STRIPE_PCT_CARD/STRIPE_FIXED are imported from ./stripe-payment-method (shared with payroll-sync.ts).

interface LocationSeed { name: string; monthlyRent: number }
const KNOWN_LOCATIONS: LocationSeed[] = [
  { name: "St. Paul's", monthlyRent: 900 },
  { name: "Cherry Valley Sports", monthlyRent: 300 },
];

// booked_location is free text typed into the live schedule, not a fixed
// enum — a live spot-check once caught it stored as "St. Paul's", not the
// fuller "St. Paul's Cathedral" this was first written with, silently
// dumping all of that month's revenue into the "Other/Unlisted" catch-all
// instead. Location Breakdown's Revenue This Month is now a live SUMIF
// formula (see buildMonthTab) doing its own wildcard "*name*" match against
// the Place column, so a small future variant of a location's name still
// won't silently stop matching.

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

interface RegRow {
  id: string;
  parent_name: string;
  email: string;
  kids: string;
  type: string;
  total_participants: number;
  booked_date: string | null;
  booked_start_time: string | null;
  booked_end_time: string | null;
  booked_location: string | null;
  booked_group: string | null;
  booked_trainer: string | null;
  status: string;
  session_price: number | null;
  applied_account_credit: number | null;
  package_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
}

interface PackageRow {
  id: string;
  created_at: string;
  package_type: number;
  status: string;
  total_price: number | null;
  applied_account_credit: number | null;
  trainer_tier: string | null;
  parent_name: string | null;
  stripe_payment_intent_id: string | null;
}

// ---------------------------------------------------------------------------
// Time helpers (same conventions as payroll-sync.ts)
// ---------------------------------------------------------------------------

function timeToDecimalHours(t: string | null): number | null {
  if (!t) return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const suffix = m[3]?.toUpperCase();
  if (suffix === "PM" && h !== 12) h += 12;
  if (suffix === "AM" && h === 12) h = 0;
  return h + min / 60;
}
function hoursBetween(start: string | null, end: string | null): number {
  const s = timeToDecimalHours(start);
  const e = timeToDecimalHours(end);
  if (s === null || e === null) return 0;
  return Math.max(Math.round((e - s) * 100) / 100, 0);
}
function sessionEndDateTime(dateStr: string, endTime: string | null): Date | null {
  const endHours = timeToDecimalHours(endTime);
  if (endHours === null) return null;
  const h = Math.floor(endHours);
  const min = Math.round((endHours - h) * 60);
  // See payroll-sync.ts's identical function for why this delegates to
  // parseSessionDateTimeET rather than building a bare, timezone-less date
  // string — that string silently parsed as UTC (the server's local time on
  // Vercel), not America/New_York, a 4-5 hour error masked only by this
  // cron's fixed early-morning schedule.
  return parseSessionDateTimeET(dateStr, h, min);
}
function normalizeTrainerName(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
/** 1-indexed column number -> A1-notation letter(s): 1->"A", 2->"B", 27->"AA". */
function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** registrations.kids is "Name (DOB: ..., Grade: ..., Gender: ...), Name2 (...)" — same split-and-strip convention already used elsewhere in this codebase (see booking/[token]/route.ts's parseKidsList). */
function parseKidNames(kidsStr: string | null): string[] {
  if (!kidsStr) return [];
  return kidsStr
    .split(/\),\s*/)
    .map((s) => s.replace(/\s*\(.*$/, "").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Row derivation
// ---------------------------------------------------------------------------

interface DerivedSession {
  registrationId: string; // used by the top-up-charge fold-in pass to match registration_topup_charges rows
  date: string;
  startHours: number; // decimal hours since midnight, for within-day chronological ordering
  trainer: string;
  isCamp: boolean;
  isGroupColumn: boolean; // Group Sessions column vs Private/Solo column
  label: string;
  grossRevenue: number;
  // The real amount actually run through Stripe for this row (post-credit,
  // $0 for package-covered/credit-only rows) — NOT yet a fee. Fees are
  // computed in a separate pass in runMonthlyRevenueSync, grouped by
  // checkoutSessionId, since a single checkout can cover several rows and
  // the service/Stripe fee is only charged once per checkout, not once per
  // row (confirmed live: someone booking 2 sessions in one checkout is
  // only charged the $4.50-ish fee once).
  stripePortion: number;
  checkoutSessionId: string | null;
  paymentIntentId: string | null; // used by the post-pass to look up card vs Link, which changes Stripe's real %
  processingFee: number; // filled in by the post-pass; 0 until then
  stripeFee: number; // filled in by the post-pass; 0 until then
  trainerPay: number;
  location: string;
}

function deriveSession(reg: RegRow, isLateCancel: boolean, lateFeeAmountKept: number): DerivedSession | null {
  if (!reg.booked_date || !reg.booked_start_time || !reg.booked_end_time) return null;
  // booked_date is stored as whatever raw format the sheet's date column
  // happened to export at booking time (e.g. "4/25/2026"), never normalized
  // to ISO at write time — every date comparison below (the tracker-start
  // cutoff, "is this already over") and the day-bucket lookup key in
  // buildMonthTab both require a real ISO string, so normalize once here
  // before anything else touches it. Same underlying bug already found and
  // fixed in reminder-emails.ts earlier this session.
  const date = normalizeDate(reg.booked_date);

  let isLoggableLate = false;
  if (reg.status === "no_show") {
    // full pay/full revenue, same as Completed
  } else if (reg.status === "confirmed") {
    const end = sessionEndDateTime(date, reg.booked_end_time);
    if (!end || end.getTime() >= Date.now()) return null; // still upcoming
  } else if (reg.status === "cancelled") {
    if (!isLateCancel) return null; // no compensable work
    isLoggableLate = true;
  } else {
    return null;
  }
  if (date < TRACKER_START_DATE) return null;

  const hours = hoursBetween(reg.booked_start_time, reg.booked_end_time);
  const participants = reg.total_participants || 1;
  const credit = reg.applied_account_credit || 0;
  const price = reg.session_price ?? 0;
  const isPackage = !!reg.package_id;

  const stripePortion = isPackage || (credit > 0 && credit >= price) ? 0 : Math.max(price - credit, 0);
  // Package-covered sessions recognize $0 incremental revenue here — the
  // full package price was already counted as revenue on the day it was
  // purchased (see derivePackage/buildMonthTab), so counting session_price
  // again on every date the client uses a session would double-count real
  // cash that only came in once. Confirmed with the owner this is the
  // wanted behavior over the previous (wrong) per-session face-value count.
  //
  // Late-cancel/reschedule revenue is NOT a flat 50% of price — the real
  // "amount kept" varies by case (bulk-discounted weekly bookings are full
  // forfeiture — 0% credited back; a multi-day full-camp row's session_price
  // is the WHOLE camp total, not that one day's share) and is already
  // computed correctly, once, at the moment of cancellation by
  // booking-finalize.ts/the cancel & reschedule routes — logged straight to
  // late_fee_events.amount_kept. Reusing that stored figure here instead of
  // re-deriving a generic 50% avoids silently mismatching real policy.
  const grossRevenue = isPackage ? 0 : isLoggableLate ? round2(lateFeeAmountKept) : price;

  const trainerNorm = normalizeTrainerName(reg.booked_trainer);
  const isSubTrainer = SUB_TRAINERS.some((t) => normalizeTrainerName(t) === trainerNorm);
  let trainerPay = 0;
  if (isSubTrainer) {
    const isWeekly = reg.type === "weekly";
    const base = isWeekly
      ? BASE_HOURLY_RATE * hours
      : (participants >= 4 ? PRIVATE_TRAINER_RATE_4PLUS : PRIVATE_TRAINER_RATE_1_3) * hours;
    const incentive = isWeekly ? INCENTIVE_PER_HEAD * Math.max(participants - 1, 0) * hours : 0;
    trainerPay = isLoggableLate ? round2((base + incentive) * 0.5) : round2(base + incentive);
  }

  const kids = parseKidNames(reg.kids);
  const kidsLabel = kids.join(", ") || reg.parent_name || reg.email || "Unknown";
  const isCamp = reg.type === "camp";
  const isGroupColumn = reg.type === "weekly" || isCamp;
  // Show what was actually kept, not the nominal session price — a late
  // cancel/reschedule only keeps part (sometimes none, sometimes all) of
  // the original price, and a label reading "$150.00" next to a day whose
  // total only reflects $75 of it would be a real audit-trail mismatch,
  // exactly the kind of discrepancy this tracker exists to avoid.
  const amountText = isPackage
    ? "(Package — already paid)"
    : isLoggableLate
      ? `$${grossRevenue.toFixed(2)} (late cancel/reschedule — kept)`
      : `$${price.toFixed(2)}`;
  const label = isCamp
    ? `[Camp] ${reg.booked_group || "Camp"} (${kidsLabel}) ${amountText}`
    : isGroupColumn
      ? `${reg.booked_group || "Group"} (${kidsLabel}) ${amountText}`
      : `${kidsLabel}${reg.type === "group-private" ? " (Group Private)" : ""} ${amountText}`;

  return {
    registrationId: reg.id,
    date,
    startHours: timeToDecimalHours(reg.booked_start_time) ?? 0,
    trainer: reg.booked_trainer || OWNER_NAME,
    isCamp,
    isGroupColumn,
    label,
    grossRevenue,
    stripePortion,
    checkoutSessionId: reg.stripe_checkout_session_id,
    paymentIntentId: reg.stripe_payment_intent_id,
    processingFee: 0,
    stripeFee: 0,
    trainerPay,
    location: reg.booked_location || "",
  };
}

interface DerivedPackage {
  date: string;
  label: string;
  totalPrice: number; // the raw package price (excl. fee) — counted as real Gross Revenue (plus processingFee, see buildMonthTab) on this date; see deriveSession's grossRevenue=0 for package-covered sessions for why this can't also be counted again per-session later
  amountCharged: number; // totalPrice MINUS account credit — what actually hit the card, and therefore the only correct base for both fees below
  processingFee: number;
  stripeFee: number; // default assumes a card payment; the payment-method-aware post-pass in runMonthlyRevenueSync overrides this for Link
  paymentIntentId: string | null;
}

function derivePackage(pkg: PackageRow): DerivedPackage | null {
  const date = pkg.created_at ? pkg.created_at.slice(0, 10) : "";
  if (!date || date < TRACKER_START_DATE) return null;
  const price = pkg.total_price ?? 0;
  // Account credit is a payment METHOD, not a discount: the package is still
  // worth its full price as Gross Revenue (the cash behind that credit was
  // never counted as revenue here — an on-time cancellation that credits a
  // family drops out of this sync entirely, see deriveSession's early
  // return, so counting the full price when the credit is spent is right and
  // doesn't double-count). The two FEE figures are a different story. At
  // checkout the service fee is charged on the post-credit remainder
  // (calcServiceFee(amountToCharge) in /api/packages), and Stripe's cut comes
  // out of what actually hit the card. Sizing either off the sticker price
  // overstated BOTH — inflating the service-fee revenue this sheet reports as
  // collected and the Stripe cost it reports as incurred. The session side
  // already gets this right (the checkout-group post-pass bases its fee on
  // the group's real stripePortion, which nets credit out); packages were the
  // one outlier.
  const appliedCredit = pkg.applied_account_credit || 0;
  const amountCharged = Math.max(0, round2(price - appliedCredit));
  const processingFee = amountCharged > 0 ? calcServiceFee(amountCharged) : 0;
  // Stripe's 2.9%+$0.30 (card) is charged on the TOTAL amount that actually
  // hits the card — amountCharged PLUS the service-fee surcharge added on top
  // at checkout. Defaults to the card rate; overridden below for Link
  // payments (2.7%+$0.30). A package covered in FULL by credit never reaches
  // Stripe at all (finalizePaidPackageEnrollment is invoked directly, with no
  // PaymentIntent), so it correctly carries neither fee.
  const stripeFee = amountCharged > 0 ? round2((amountCharged + processingFee) * STRIPE_PCT_CARD + STRIPE_FIXED) : 0;
  const size = pkg.package_type === 8 ? "8-Pack" : "4-Pack";
  const buyer = pkg.parent_name || "Unknown";
  // Spell out the split when credit was involved — a row reading "$200.00"
  // next to a fee sized off $175 is exactly the audit-trail mismatch this
  // tracker exists to prevent (same reasoning as deriveSession's amountText).
  const creditNote = appliedCredit > 0 ? ` ($${appliedCredit.toFixed(2)} credit, $${amountCharged.toFixed(2)} charged)` : "";
  return { date, label: `${buyer} — ${size} $${price.toFixed(2)}${creditNote}`, totalPrice: price, amountCharged, processingFee, stripeFee, paymentIntentId: pkg.stripe_payment_intent_id };
}

// ---------------------------------------------------------------------------
// Rich-text cell helper
// ---------------------------------------------------------------------------

interface TextSegment { text: string; color?: RgbColor; bold?: boolean }

function richTextCellData(segments: TextSegment[]) {
  const parts: string[] = [];
  const runs: { startIndex: number; format: { foregroundColor: { red: number; green: number; blue: number }; bold?: boolean } }[] = [];
  let offset = 0;
  for (const seg of segments) {
    runs.push({ startIndex: offset, format: { foregroundColor: seg.color || { red: 0, green: 0, blue: 0 }, bold: seg.bold } });
    parts.push(seg.text);
    offset += seg.text.length + 1; // +1 for the \n joiner
  }
  return { stringValue: parts.join("\n"), textFormatRuns: runs };
}

// ---------------------------------------------------------------------------
// Month tab layout
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}
function monthTabName(year: number, month1: number): string {
  const name = new Date(year, month1 - 1, 1).toLocaleDateString("en-US", { month: "long" });
  return `${name} ${year}`;
}
function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function ensureMonthTab(tabName: string): Promise<number> {
  const meta = await getSheetMeta(MONTHLY_REVENUE_SHEET_ID);
  const existing = meta.find((s) => s.title === tabName);
  if (existing) return existing.sheetId;
  // Google auto-creates a blank "Sheet1" on new spreadsheets — repurpose it
  // for the first real month instead of leaving it as clutter.
  const blank = meta.find((s) => s.title === "Sheet1" && meta.length === 1);
  if (blank) {
    await batchUpdate(MONTHLY_REVENUE_SHEET_ID, [
      { updateSheetProperties: { properties: { sheetId: blank.sheetId, title: tabName }, fields: "title" } },
    ]);
    return blank.sheetId;
  }
  const res = await batchUpdate(MONTHLY_REVENUE_SHEET_ID, [{ addSheet: { properties: { title: tabName } } }]);
  // batchUpdate here returns void per sheets-write.ts's signature — refetch to get the new sheetId.
  void res;
  const meta2 = await getSheetMeta(MONTHLY_REVENUE_SHEET_ID);
  const created = meta2.find((s) => s.title === tabName);
  if (!created) throw new Error(`Failed to create tab "${tabName}"`);
  return created.sheetId;
}

/** Scans a wide range below Month Totals for (Location name, Rent) pairs,
 * keyed by name rather than row position — the Location Breakdown section's
 * row position shifts (a week appearing/disappearing in Trainer Pay above
 * it moves everything below), so reading "whatever's currently at this row
 * number" is unsafe: it silently grabbed a DIFFERENT location's rent after
 * a shift once, corrupting both. Returns an empty map if nothing's there
 * yet (new tab). */
async function readExistingRentByName(tabName: string, scanStartRow1: number, scanRows: number): Promise<Map<string, number>> {
  const rows = await getValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(tabName)}!A${scanStartRow1}:B${scanStartRow1 + scanRows}`);
  const map = new Map<string, number>();
  for (const row of rows) {
    const name = String((row as unknown[])?.[0] ?? "").trim();
    const rent = (row as unknown[])?.[1];
    if (name && typeof rent === "number") map.set(name, rent);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Day-row edit protection — lets the owner hand-correct a day's row (e.g. a
// fee that used old pricing) without it silently reverting on the next
// daily sync. Hidden tab keyed by "<month tab>|<date>" -> a fingerprint of
// exactly what THIS sync last wrote for that day's C:I columns. Mirrors
// payroll-sync.ts's _SyncLog pattern, applied per day-row instead of per
// registration.
// ---------------------------------------------------------------------------

const DAY_LOG_TAB = "_DayLog";

interface DayLogEntry {
  row: number; // 1-indexed row in _DayLog
  textFingerprint: string;
  feeFingerprint: string;
}

async function ensureDayLogTab(): Promise<void> {
  const meta = await getSheetMeta(MONTHLY_REVENUE_SHEET_ID);
  if (meta.some((s) => s.title === DAY_LOG_TAB)) return;
  await batchUpdate(MONTHLY_REVENUE_SHEET_ID, [
    { addSheet: { properties: { title: DAY_LOG_TAB, hidden: true } } },
  ]);
  await updateValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(DAY_LOG_TAB)}!A1:C1`, [["key", "textFingerprint", "feeFingerprint"]]);
}

async function readDayLog(): Promise<Map<string, DayLogEntry>> {
  const rows = await getValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(DAY_LOG_TAB)}!A2:C`);
  const map = new Map<string, DayLogEntry>();
  rows.forEach((r, i) => {
    const [key, textFingerprint, feeFingerprint] = r as [string, string, string];
    if (!key) return;
    map.set(key, { row: i + 2, textFingerprint: textFingerprint || "", feeFingerprint: feeFingerprint || "" });
  });
  return map;
}

/** Fingerprints the session-list text + Place — TEXT lock only. Kept
 * strictly separate from the fee fingerprint below: text and fees are
 * edited independently (the owner might fix a fee without ever touching
 * the session list, or vice versa), and — critically — Processing/Stripe
 * legitimately change on their own whenever the underlying booking data
 * does (a participant added after the fact, a price correction), with no
 * owner edit involved at all. Bundling that drift into the SAME lock as
 * the text once meant a routine data change alone could permanently freeze
 * a day's whole row, silently, forever — exactly the bug that surfaced
 * live on 2026-08-08 (Aug 1 stuck showing a stale Processing Fee from
 * early in the day, dragging Gross Revenue down with it, with no owner
 * edit responsible at all). */
function textFingerprint(privateText: string, groupText: string, place: string): string {
  return JSON.stringify([privateText, groupText, place]);
}

/** Fingerprints Processing + Stripe Fee — FEE lock only, independent of
 * the text lock above. This is what lets a fee correction like Maria
 * VORKAS's stick permanently, without that same mechanism accidentally
 * freezing Gross/session-text on a day the owner never touched. */
function feeFingerprint(processing: number, stripe: number): string {
  return JSON.stringify([processing, stripe]);
}

/** Sums every "$X.XX" (or "$X,XXX.XX") dollar figure found in a block of
 * text — used to re-derive a locked day's Gross Revenue straight from
 * whatever the owner's session-list text currently says, instead of a
 * frozen number that can silently drift out of sync with an edit. */
function parseDollarSum(text: string): number {
  const matches = text.match(/\$([\d,]+\.\d{2})/g) || [];
  return round2(matches.reduce((sum, m) => sum + parseFloat(m.replace(/[$,]/g, "")), 0));
}

async function buildMonthTab(
  year: number,
  month1: number,
  sessions: DerivedSession[],
  packages: DerivedPackage[],
  dayLog: Map<string, DayLogEntry>,
  dayLogWrites: Map<string, { text?: string; fee?: string }>
): Promise<void> {
  const tabName = monthTabName(year, month1);
  const sheetId = await ensureMonthTab(tabName);
  const nDays = daysInMonth(year, month1);
  const monthPrefix = `${year}-${String(month1).padStart(2, "0")}`;
  // One batched read of every day-row's live C:I content, so we can detect
  // a manual edit (live content diverging from what we last wrote) without
  // one getValues call per day.
  const liveDayRows = await getValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(tabName)}!C9:I${8 + nDays}`);

  // PICKUPS — off-the-books cash games the owner runs himself (not on the
  // live schedule, no Stripe fees since it's cash-in-hand). Always at
  // St. Paul's per the owner. Lives in columns K:M (Date/Name/Amount),
  // entirely outside the A:J range every other write in this file touches
  // (including the big clear-region below) — so the owner's entered
  // dates/names/amounts (K11:M60) are NEVER touched by any sync run, only
  // the header labels and the TOTAL formula get (re)written each time,
  // same "manual input survives a rebuild" pattern as rent. The TOTAL cell
  // is a fixed, always-the-same location ($M$61) that Location Breakdown's
  // St. Paul's row, the Other/Unlisted row (to keep the location totals
  // reconciling with Month Totals), and Net Profit to Mesa all read
  // directly by formula. The title cell (K9) is written value-only — its
  // format (color/font) is whatever the owner set by hand and this file
  // never touches it, so it can never get silently reverted by a sync.
  const PICKUPS_DATA_FIRST_ROW1 = 11;
  const PICKUPS_DATA_LAST_ROW1 = 60;
  const PICKUPS_TOTAL_ROW1 = 61;
  const PICKUPS_TOTAL_CELL = `$M$${PICKUPS_TOTAL_ROW1}`;

  const requests: object[] = [];

  // Row 1: title
  requests.push(titleRowRequest(sheetId, 0, `MESA BASKETBALL TRAINING — ${tabName.toUpperCase()}`));
  // Row 2: subtitle
  requests.push(subtitleRowRequest(sheetId, 1, "Every session, no matter the trainer. Auto-generated — nothing to enter except the rent cells below."));

  // Row 4 (index 3): trainer color key
  const keySegments: TextSegment[] = [
    { text: "Trainer key:  ", color: { red: 0, green: 0, blue: 0 }, bold: true },
    { text: OWNER_NAME, color: TRAINER_COLOR[OWNER_NAME], bold: true },
    ...SUB_TRAINERS.map((t) => ({ text: t, color: TRAINER_COLOR[t], bold: true })),
    { text: "Camps", color: CAMP_COLOR, bold: true },
  ];
  requests.push(inlineKeyRowRequest(sheetId, 3, keySegments));

  // Row 6 (index 5): packages sold this month
  const pkgLabel = packages.length > 0
    ? "Packages sold this month:  " + packages.map((p) => p.label).join("   |   ")
    : "Packages sold this month: none";
  requests.push(subtitleRowRequest(sheetId, 5, pkgLabel));

  // Row 8 (index 7): header
  const headers = ["Date", "Day", "Private / Solo Sessions", "Group Sessions", "Place", "Gross Revenue", "Processing Fee", "Stripe Fee", "Net Revenue"];
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: headers.length },
      cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: { bold: true, foregroundColorStyle: { rgbColor: WHITE } } } },
      fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
    },
  });
  requests.push({
    updateCells: {
      rows: [{ values: headers.map((h) => ({ userEnteredValue: { stringValue: h } })) }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: 7, columnIndex: 0 },
    },
  });

  const sessionsByDate = new Map<string, DerivedSession[]>();
  for (const s of sessions) {
    if (!s.date.startsWith(monthPrefix)) continue;
    if (!sessionsByDate.has(s.date)) sessionsByDate.set(s.date, []);
    sessionsByDate.get(s.date)!.push(s);
  }
  // Packages are recognized as revenue on their purchase date (cash-basis —
  // see deriveSession's comment on why individual package-covered sessions
  // don't ALSO count) — bucket by date here so buildMonthTab can fold each
  // day's package total into that day's Gross/Processing/Stripe/Net, not
  // just show it in the informational month-level label.
  const packagesByDate = new Map<string, DerivedPackage[]>();
  for (const p of packages) {
    if (!p.date.startsWith(monthPrefix)) continue;
    if (!packagesByDate.has(p.date)) packagesByDate.set(p.date, []);
    packagesByDate.get(p.date)!.push(p);
  }

  // Trainer pay isn't recoverable from anywhere else in the sheet (no
  // per-session cells to sum), so it's the one genuine exception to "every
  // total is a formula" — these are real values written directly, per
  // trainer per week; see the TRAINER PAY BY WEEK section below for how its
  // own row/grand totals ARE formulas over these cells.
  const trainerPayByWeek = new Map<string, Map<string, number>>(); // week -> trainer -> pay

  for (let d = 1; d <= nDays; d++) {
    const dateStr = `${monthPrefix}-${String(d).padStart(2, "0")}`; // ISO — internal keying only (day-log, session/package date matching)
    const dateDisplay = new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); // "August 1, 2026" — what actually shows in column A
    const dayName = new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
    // Chronological within the day, not insertion order — ties (two
    // trainers running sessions at the same start time) keep whatever
    // relative order they arrived in, which is fine per instruction.
    const daySessions = (sessionsByDate.get(dateStr) || []).slice().sort((a, b) => a.startHours - b.startHours);

    const privateSegs: TextSegment[] = [];
    const groupSegs: TextSegment[] = [];
    const places = new Set<string>();
    // gPriceOnly is the base session/package price total, WITHOUT the fee
    // surcharge — kept separate from Gross (F) itself, since F = price +
    // whichever G value actually wins (fresh or fee-locked — see below).
    let gPriceOnly = 0, gProcessing = 0, gStripe = 0;

    daySessions.forEach((s) => {
      // Numbered within its own column (Private vs Group), not across the
      // combined day list — otherwise a day with 2 group sessions before 1
      // private session mislabels the lone private entry "3." instead of
      // "1.", which is exactly what a spot-check on 2026-08-07 caught.
      const n = (s.isGroupColumn ? groupSegs.length : privateSegs.length) + 1;
      const seg: TextSegment = { text: `${n}. ${s.label}`, color: s.isCamp ? CAMP_COLOR : TRAINER_COLOR[s.trainer] || CAMP_COLOR };
      if (s.isGroupColumn) groupSegs.push(seg); else privateSegs.push(seg);
      if (s.location) places.add(s.location);
      gPriceOnly += s.grossRevenue;
      gProcessing += s.processingFee;
      gStripe += s.stripeFee;

      if (s.trainerPay > 0) {
        const wk = mondayOf(s.date);
        if (!trainerPayByWeek.has(wk)) trainerPayByWeek.set(wk, new Map());
        const wkMap = trainerPayByWeek.get(wk)!;
        wkMap.set(s.trainer, round2((wkMap.get(s.trainer) || 0) + s.trainerPay));
      }
    });

    // Package purchases made this day — shown as their own unnumbered line
    // (not mixed into the numbered session list) and folded straight into
    // the day's totals. Not attributed to any location (packages aren't
    // gym-specific), so — like any other unattributed revenue — it lands in
    // "Other/Unlisted" in the Location Breakdown below, which is correct.
    for (const p of packagesByDate.get(dateStr) || []) {
      privateSegs.push({ text: `[Package Purchased] ${p.label}`, color: { red: 0, green: 0, blue: 0 }, bold: true });
      gPriceOnly += p.totalPrice;
      gProcessing += p.processingFee;
      gStripe += p.stripeFee;
    }

    const rowIndex0 = 8 + (d - 1); // header is row index 7 (row 8, 1-indexed)
    const rowNum1 = rowIndex0 + 1; // 1-indexed, for building formula strings
    const privateCell = privateSegs.length > 0 ? richTextCellData(privateSegs) : null;
    const groupCell = groupSegs.length > 0 ? richTextCellData(groupSegs) : null;
    const placesStr = Array.from(places).join(" / ");

    // Text-locked and fee-locked are checked INDEPENDENTLY — a day's
    // session-list text and its Processing/Stripe Fee are edited (or left
    // alone) completely separately in practice. Bundling them into one
    // all-or-nothing lock was the bug: Processing/Stripe legitimately
    // change on their own whenever the underlying booking data does (a
    // participant added after the fact, a price correction) with no owner
    // edit involved — that alone was enough to freeze a day's whole row,
    // silently, forever. A never-logged day is treated as unlocked on both
    // counts: either it's brand new, or it's a day from before this
    // protection existed, getting one final overwrite and logged from then on.
    const logKey = `${tabName}|${dateStr}`;
    const stored = dayLog.get(logKey);
    const freshTextFp = textFingerprint(privateCell?.stringValue ?? "", groupCell?.stringValue ?? "", placesStr);
    const freshFeeFp = feeFingerprint(gProcessing, gStripe);
    const liveRow = liveDayRows[d - 1] || [];
    const textLocked = !!stored && textFingerprint(String(liveRow[0] ?? ""), String(liveRow[1] ?? ""), String(liveRow[2] ?? "")) !== stored.textFingerprint;
    const feeLocked = !!stored && feeFingerprint(Number(liveRow[4]) || 0, Number(liveRow[5]) || 0) !== stored.feeFingerprint;

    // WRAP explicitly — otherwise Sheets' default wrap strategy only
    // auto-expands row height inconsistently (observed live: a day with 9
    // combined lines expanded fine, one with only 2-3 got clipped).
    const wrapFormat = { wrapStrategy: "WRAP" };
    // Date/Day never change — always safe to (re)write.
    requests.push({
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { stringValue: dateDisplay } }, { userEnteredValue: { stringValue: dayName } }] }],
        fields: "userEnteredValue",
        start: { sheetId, rowIndex: rowIndex0, columnIndex: 0 },
      },
    });

    let priceComponent: number;
    if (textLocked) {
      // Re-derive straight from the live session-list text (summing every
      // "$X.XX" it contains) rather than trusting a frozen number — so
      // removing/editing a line item is, by itself, enough to correct the
      // total.
      priceComponent = round2(parseDollarSum(String(liveRow[0] ?? "")) + parseDollarSum(String(liveRow[1] ?? "")));
    } else {
      priceComponent = gPriceOnly;
      dayLogWrites.set(logKey, { text: freshTextFp });
      requests.push({
        updateCells: {
          rows: [{
            values: [
              privateCell
                ? { userEnteredValue: { stringValue: privateCell.stringValue }, textFormatRuns: privateCell.textFormatRuns, userEnteredFormat: wrapFormat }
                : { userEnteredValue: { stringValue: "" } },
              groupCell
                ? { userEnteredValue: { stringValue: groupCell.stringValue }, textFormatRuns: groupCell.textFormatRuns, userEnteredFormat: wrapFormat }
                : { userEnteredValue: { stringValue: "" } },
              { userEnteredValue: { stringValue: placesStr } },
            ],
          }],
          fields: "userEnteredValue,userEnteredFormat,textFormatRuns",
          start: { sheetId, rowIndex: rowIndex0, columnIndex: 2 },
        },
      });
    }

    if (feeLocked) {
      // Whatever the owner left in Processing/Stripe Fee stays exactly as
      // it is — this is what lets a fee correction like Bryan Schrubbe's
      // (or Maria VORKAS's) stick permanently, independent of the text
      // lock above.
    } else {
      dayLogWrites.set(logKey, { ...(dayLogWrites.get(logKey) || {}), fee: freshFeeFp });
      requests.push({
        updateCells: {
          rows: [{
            values: [
              { userEnteredValue: { numberValue: gProcessing }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
              { userEnteredValue: { numberValue: gStripe }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
            ],
          }],
          fields: "userEnteredValue,userEnteredFormat",
          start: { sheetId, rowIndex: rowIndex0, columnIndex: 6 },
        },
      });
    }

    // Gross (F) is price ONLY — NOT fee-inclusive. Processing Fee is shown
    // as its own column, exactly what it is: a separate surcharge, not part
    // of "how much the session/package itself sold for." Net (I) is ALWAYS
    // a formula, =F+G-H, so it self-updates the instant the owner edits
    // Gross, Processing, or Stripe directly, with no sync needed.
    requests.push({
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { numberValue: round2(priceComponent) }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }] }],
        fields: "userEnteredValue,userEnteredFormat",
        start: { sheetId, rowIndex: rowIndex0, columnIndex: 5 },
      },
    });
    requests.push({
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { formulaValue: `=F${rowNum1}+G${rowNum1}-H${rowNum1}` }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }] }],
        fields: "userEnteredValue,userEnteredFormat",
        start: { sheetId, rowIndex: rowIndex0, columnIndex: 8 },
      },
    });
  }

  // TOTALS row — real SUM formulas over the day rows above, not
  // independently-tracked JS totals, so this is always exactly "what's in
  // the sheet, added up" and stays correct even if a day row is hand-edited
  // after the fact with no further sync needed.
  const totalsRow0 = 8 + nDays;
  const totalsRow1 = totalsRow0 + 1;
  const firstDayRow1 = 9;
  const lastDayRow1 = 8 + nDays;
  const currencyFmt = { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } };
  requests.push({
    updateCells: {
      rows: [
        {
          values: [
            { userEnteredValue: { stringValue: "MONTH TOTALS" }, userEnteredFormat: { textFormat: { bold: true } } },
            { userEnteredValue: { stringValue: "" } },
            { userEnteredValue: { stringValue: "" } },
            { userEnteredValue: { stringValue: "" } },
            { userEnteredValue: { stringValue: "" } },
            { userEnteredValue: { formulaValue: `=SUM(F${firstDayRow1}:F${lastDayRow1})` }, userEnteredFormat: { textFormat: { bold: true }, ...currencyFmt } },
            { userEnteredValue: { formulaValue: `=SUM(G${firstDayRow1}:G${lastDayRow1})` }, userEnteredFormat: { textFormat: { bold: true }, ...currencyFmt } },
            { userEnteredValue: { formulaValue: `=SUM(H${firstDayRow1}:H${lastDayRow1})` }, userEnteredFormat: { textFormat: { bold: true }, ...currencyFmt } },
            { userEnteredValue: { formulaValue: `=SUM(I${firstDayRow1}:I${lastDayRow1})` }, userEnteredFormat: { textFormat: { bold: true }, ...currencyFmt } },
          ],
        },
      ],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: totalsRow0, columnIndex: 0 },
    },
  });

  // PICKUPS table — title/header labels and the TOTAL formula are
  // rewritten every run (harmless, just labels/a formula); the data rows
  // (K11:M60) are never referenced by any updateCells request anywhere in
  // this file, so whatever the owner types there survives every rebuild
  // untouched, exactly like the rent cells. The title's own format
  // (fill color, italic, etc.) is the owner's own manual styling — only
  // its text is ever rewritten, never its format, so that styling is
  // permanent no matter how many times this runs.
  requests.push({
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: "Pickups - (St. Paul's)" } }] }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: 8, columnIndex: 10 },
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 10, endColumnIndex: 13 },
      cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: { bold: true, foregroundColorStyle: { rgbColor: WHITE } } } },
      fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
    },
  });
  requests.push({
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: "Date" } }, { userEnteredValue: { stringValue: "Name" } }, { userEnteredValue: { stringValue: "Amount" } }] }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: 9, columnIndex: 10 },
    },
  });
  requests.push({
    updateCells: {
      rows: [{
        values: [
          { userEnteredValue: { stringValue: "TOTAL" }, userEnteredFormat: { textFormat: { bold: true } } },
          { userEnteredValue: { stringValue: "" } },
          {
            userEnteredValue: { formulaValue: `=SUM(M${PICKUPS_DATA_FIRST_ROW1}:M${PICKUPS_DATA_LAST_ROW1})` },
            userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } },
          },
        ],
      }],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: PICKUPS_TOTAL_ROW1 - 1, columnIndex: 10 },
    },
  });

  // Everything below Month Totals (Trainer Pay, Location Breakdown, Net
  // Profit) is at a row position that shifts month to month (more/fewer
  // weeks changes how many trainer-pay rows there are) and, now, run to run
  // too (a week appearing/disappearing shifts the grand TOTAL row and
  // everything under it). Without this, a section that lands on fewer rows
  // than the last run leaves the previous run's content sitting there as an
  // orphaned duplicate — exactly what happened here (a stale "Net Profit"
  // row from before the Trainer Pay TOTAL row existed). Clearing a generous
  // range first guarantees a clean slate every run regardless of how the
  // layout shifts.
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: totalsRow0 + 1, endRowIndex: totalsRow0 + 1 + 120, startColumnIndex: 0, endColumnIndex: 10 },
      cell: { userEnteredValue: {}, userEnteredFormat: {} },
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // TRAINER PAY BY WEEK — the individual per-trainer/per-week amounts are
  // the one genuine exception ("a number directly pulled, not summable from
  // other cells" — there's no per-session row here to add up). Every total
  // that DOES sit on top of them (each week's row Total, and the grand
  // TOTAL row below) is a real formula.
  let row0 = totalsRow0 + 2;
  requests.push(subtitleHeaderRequest(sheetId, row0, "TRAINER PAY BY WEEK"));
  row0 += 1;
  const payHeaders = ["Week of", ...SUB_TRAINERS, "Total"];
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: row0, endRowIndex: row0 + 1, startColumnIndex: 0, endColumnIndex: payHeaders.length },
      cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: { bold: true, foregroundColorStyle: { rgbColor: WHITE } } } },
      fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
    },
  });
  requests.push({
    updateCells: {
      rows: [{ values: payHeaders.map((h) => ({ userEnteredValue: { stringValue: h } })) }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: row0, columnIndex: 0 },
    },
  });
  row0 += 1;
  const trainerDataStartRow0 = row0;
  const lastTrainerColLetter = colLetter(1 + SUB_TRAINERS.length); // "F" for 5 trainers (B..F)
  const weeks = Array.from(trainerPayByWeek.keys()).sort();
  for (const wk of weeks) {
    const wkMap = trainerPayByWeek.get(wk)!;
    const weekRowNum1 = row0 + 1;
    const values: object[] = [{ userEnteredValue: { stringValue: wk } }];
    for (const t of SUB_TRAINERS) {
      values.push({ userEnteredValue: { numberValue: wkMap.get(t) || 0 } });
    }
    values.push({ userEnteredValue: { formulaValue: `=SUM(B${weekRowNum1}:${lastTrainerColLetter}${weekRowNum1})` } });
    requests.push({
      updateCells: {
        rows: [{ values }],
        fields: "userEnteredValue",
        start: { sheetId, rowIndex: row0, columnIndex: 0 },
      },
    });
    row0 += 1;
  }
  if (weeks.length === 0) {
    requests.push({
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { stringValue: "No sub-trainer sessions this month" } }] }],
        fields: "userEnteredValue",
        start: { sheetId, rowIndex: row0, columnIndex: 0 },
      },
    });
    row0 += 1;
  }
  // Grand total row — sums straight down each trainer's own column across
  // every week row (or, with zero weeks, across the harmless placeholder
  // text row above, which contributes $0 since B:F are blank there).
  const trainerDataEndRow1 = row0; // 1-indexed last data/placeholder row
  const trainerDataStartRow1 = trainerDataStartRow0 + 1;
  const trainerTotalRow0 = row0;
  const trainerTotalRow1 = trainerTotalRow0 + 1;
  const trainerTotalValues: object[] = [{ userEnteredValue: { stringValue: "TOTAL" }, userEnteredFormat: { textFormat: { bold: true } } }];
  for (let i = 0; i < SUB_TRAINERS.length; i++) {
    const col = colLetter(2 + i);
    trainerTotalValues.push({
      userEnteredValue: { formulaValue: `=SUM(${col}${trainerDataStartRow1}:${col}${trainerDataEndRow1})` },
      userEnteredFormat: { textFormat: { bold: true } },
    });
  }
  trainerTotalValues.push({
    userEnteredValue: { formulaValue: `=SUM(B${trainerTotalRow1}:${lastTrainerColLetter}${trainerTotalRow1})` },
    userEnteredFormat: { textFormat: { bold: true } },
  });
  requests.push({
    updateCells: {
      rows: [{ values: trainerTotalValues }],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: trainerTotalRow0, columnIndex: 0 },
    },
  });
  const trainerGrandTotalCell = `${colLetter(2 + SUB_TRAINERS.length)}${trainerTotalRow1}`; // e.g. "G{row}"
  row0 += 1;

  // LOCATION BREAKDOWN — Revenue This Month is a SUMIF straight against the
  // day rows' own Place (E) and Gross Revenue (F) columns, so it always
  // matches whatever those actually say, hand-edited or not. Net is just
  // Revenue-Rent on the same row.
  row0 += 1;
  requests.push(subtitleHeaderRequest(sheetId, row0, "LOCATION BREAKDOWN"));
  row0 += 1;
  const locHeaders = ["Location", "Monthly Rent (edit me)", "Revenue This Month", "Net"];
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: row0, endRowIndex: row0 + 1, startColumnIndex: 0, endColumnIndex: locHeaders.length },
      cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: { bold: true, foregroundColorStyle: { rgbColor: WHITE } } } },
      fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
    },
  });
  requests.push({
    updateCells: {
      rows: [{ values: locHeaders.map((h) => ({ userEnteredValue: { stringValue: h } })) }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: row0, columnIndex: 0 },
    },
  });
  row0 += 1;
  const firstLocRow1 = row0 + 1;
  // Read BEFORE the clear-region request (queued above, not yet sent —
  // it only takes effect once batchUpdate runs at the end of this
  // function) executes, so this still sees whatever rent was really there.
  const existingRentByName = await readExistingRentByName(tabName, totalsRow0 + 1, 120);
  for (const loc of KNOWN_LOCATIONS) {
    const rent = existingRentByName.get(loc.name) ?? loc.monthlyRent;
    const locRowNum1 = row0 + 1;
    // St. Paul's is the only location where the owner runs cash pickup
    // games — see the PICKUPS table above — so its Revenue folds in the
    // pickups TOTAL cell on top of the normal SUMIF over booked sessions.
    const revenueFormula = loc.name === "St. Paul's"
      ? `=SUMIF(E${firstDayRow1}:E${lastDayRow1},"*"&A${locRowNum1}&"*",F${firstDayRow1}:F${lastDayRow1})+${PICKUPS_TOTAL_CELL}`
      : `=SUMIF(E${firstDayRow1}:E${lastDayRow1},"*"&A${locRowNum1}&"*",F${firstDayRow1}:F${lastDayRow1})`;
    requests.push({
      updateCells: {
        rows: [{
          values: [
            { userEnteredValue: { stringValue: loc.name } },
            { userEnteredValue: { numberValue: rent } },
            { userEnteredValue: { formulaValue: revenueFormula } },
            { userEnteredValue: { formulaValue: `=C${locRowNum1}-B${locRowNum1}` } },
          ],
        }],
        fields: "userEnteredValue",
        start: { sheetId, rowIndex: row0, columnIndex: 0 },
      },
    });
    row0 += 1;
  }
  const lastLocRow1 = row0; // 1-indexed last KNOWN_LOCATIONS row
  const otherRowNum1 = row0 + 1;
  requests.push({
    updateCells: {
      rows: [{
        values: [
          { userEnteredValue: { stringValue: "Other / Unlisted" } },
          { userEnteredValue: { numberValue: 0 } },
          // +PICKUPS_TOTAL_CELL here isn't pickups revenue landing in
          // "Other" — it's cancelling out the same amount that was just
          // added to St. Paul's above, so the location rows still
          // reconcile to Month Totals' Gross Revenue + Pickups, not less.
          { userEnteredValue: { formulaValue: `=F${totalsRow1}+${PICKUPS_TOTAL_CELL}-SUM(C${firstLocRow1}:C${lastLocRow1})` } },
          { userEnteredValue: { formulaValue: `=C${otherRowNum1}-B${otherRowNum1}` } },
        ],
      }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: row0, columnIndex: 0 },
    },
  });
  row0 += 2;

  // NET PROFIT TO MESA — references Month Totals' own Net Revenue cell,
  // the Trainer Pay grand total cell, and the location rows' own Rent
  // column, instead of independently-tracked JS running totals.
  requests.push({
    updateCells: {
      rows: [{
        values: [
          { userEnteredValue: { stringValue: "NET PROFIT TO MESA THIS MONTH" }, userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } },
          { userEnteredValue: { stringValue: "" } },
          {
            userEnteredValue: { formulaValue: `=I${totalsRow1}+${PICKUPS_TOTAL_CELL}-${trainerGrandTotalCell}-SUM(B${firstLocRow1}:B${lastLocRow1})` },
            userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, ...currencyFmt },
          },
          { userEnteredValue: { stringValue: "= Net Revenue + Pickups − Trainer Pay − Rent" } },
        ],
      }],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: row0, columnIndex: 0 },
    },
  });

  await batchUpdate(MONTHLY_REVENUE_SHEET_ID, requests);
}

function titleRowRequest(sheetId: number, rowIndex0: number, text: string) {
  return {
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: text }, userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } }] }],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: rowIndex0, columnIndex: 0 },
    },
  };
}
function subtitleRowRequest(sheetId: number, rowIndex0: number, text: string) {
  return {
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: text }, userEnteredFormat: { textFormat: { italic: true } } }] }],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: rowIndex0, columnIndex: 0 },
    },
  };
}
function subtitleHeaderRequest(sheetId: number, rowIndex0: number, text: string) {
  return {
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: text }, userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } }] }],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: rowIndex0, columnIndex: 0 },
    },
  };
}
function inlineKeyRowRequest(sheetId: number, rowIndex0: number, segments: TextSegment[]) {
  // Single-line, space-joined (not newline-joined like the day cells) — build manually.
  const parts: string[] = [];
  const runs: { startIndex: number; format: { foregroundColor: RgbColor; bold?: boolean } }[] = [];
  let offset = 0;
  segments.forEach((seg, i) => {
    const text = i < segments.length - 1 ? seg.text + "    " : seg.text;
    runs.push({ startIndex: offset, format: { foregroundColor: seg.color || { red: 0, green: 0, blue: 0 }, bold: seg.bold } });
    parts.push(text);
    offset += text.length;
  });
  return {
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: parts.join("") }, textFormatRuns: runs }] }],
      fields: "userEnteredValue,textFormatRuns",
      start: { sheetId, rowIndex: rowIndex0, columnIndex: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface MonthlyRevenueSyncResult {
  monthsBuilt: string[];
  sessionsConsidered: number;
  packagesConsidered: number;
}

export async function runMonthlyRevenueSync(): Promise<MonthlyRevenueSyncResult> {
  const supabase = getSupabase();

  // No server-side date filter here on purpose — booked_date isn't reliably
  // stored in ISO format (same reasoning as reminder-emails.ts and
  // getRemainingPackageCapacity), so a `.gte` comparison against a raw
  // string would silently drop legitimately-in-scope rows. Fetch broadly by
  // type/status instead and apply the real (normalized) date cutoff inside
  // deriveSession.
  const { data: regs, error: regErr } = await supabase
    .from("registrations")
    .select(
      "id, parent_name, email, kids, type, total_participants, booked_date, booked_start_time, booked_end_time, booked_location, booked_group, booked_trainer, status, session_price, applied_account_credit, package_id, stripe_checkout_session_id, stripe_payment_intent_id"
    )
    .in("type", ["weekly", "private", "group-private", "camp"])
    .in("status", ["confirmed", "cancelled", "no_show"]);
  if (regErr) throw new Error(`registrations query: ${regErr.message}`);
  const registrations = (regs || []) as RegRow[];

  const cancelledIds = registrations.filter((r) => r.status === "cancelled").map((r) => r.id);
  const isLateCancelById = new Map<string, boolean>();
  // The real dollar amount actually kept (not credited/refunded back) for a
  // late cancellation or late reschedule — sourced from late_fee_events
  // instead of re-derived here, since the true policy varies by case (see
  // deriveSession's comment) and is already computed correctly, once, at
  // the moment of cancellation.
  const amountKeptById = new Map<string, number>();
  if (cancelledIds.length > 0) {
    const [{ data: lateFlags }, { data: lateFeeRows }] = await Promise.all([
      supabase.from("registrations").select("id, is_late_cancel").in("id", cancelledIds),
      supabase.from("late_fee_events").select("registration_id, amount_kept").in("registration_id", cancelledIds),
    ]);
    for (const row of (lateFlags || []) as { id: string; is_late_cancel: boolean | null }[]) {
      isLateCancelById.set(row.id, !!row.is_late_cancel);
    }
    for (const row of (lateFeeRows || []) as { registration_id: string | null; amount_kept: number | null }[]) {
      if (!row.registration_id) continue;
      amountKeptById.set(row.registration_id, round2((amountKeptById.get(row.registration_id) ?? 0) + (row.amount_kept ?? 0)));
    }
  }

  const sessions: DerivedSession[] = [];
  for (const reg of registrations) {
    const derived = deriveSession(reg, isLateCancelById.get(reg.id) ?? false, amountKeptById.get(reg.id) ?? 0);
    if (derived) sessions.push(derived);
  }

  // Card-vs-Link lookup, shared by both the session and package fee
  // post-passes below (see resolveStripePct's header comment).
  await ensurePaymentMethodCacheTab(MONTHLY_REVENUE_SHEET_ID);
  const pmCache = await readPaymentMethodCache(MONTHLY_REVENUE_SHEET_ID);
  const pmCacheWrites = new Map<string, string>();
  const stripeLookupBudget = { remaining: MAX_STRIPE_LOOKUPS_PER_RUN };

  // A single Stripe Checkout can cover several session rows (e.g. booking 2
  // sessions at once) — the ~$4.50/3.2% service fee and the real Stripe cost
  // are charged/incurred ONCE per checkout, not once per row. Group by
  // checkoutSessionId and assign the fee, computed on the group's combined
  // charged amount, to a single representative row (the earliest-dated one)
  // so every other row in the group stays at $0 — otherwise summing each
  // row's own fee independently overcounts exactly the case flagged live:
  // "booked 3 group kids... paid the 4.50 fee 3 times" when in reality it
  // was one checkout, one fee.
  const checkoutGroups = new Map<string, DerivedSession[]>();
  for (const s of sessions) {
    if (!s.checkoutSessionId || s.stripePortion <= 0) continue;
    if (!checkoutGroups.has(s.checkoutSessionId)) checkoutGroups.set(s.checkoutSessionId, []);
    checkoutGroups.get(s.checkoutSessionId)!.push(s);
  }
  for (const group of checkoutGroups.values()) {
    const totalCharged = round2(group.reduce((sum, s) => sum + s.stripePortion, 0));
    if (totalCharged <= 0) continue;
    const rep = group.slice().sort((a, b) => a.date.localeCompare(b.date) || a.startHours - b.startHours)[0];
    rep.processingFee = calcServiceFee(totalCharged);
    // Stripe's %+$0.30 is charged on the TOTAL amount that actually hits
    // the card — totalCharged PLUS the service-fee surcharge added on top
    // at checkout — not on the session price alone. The % itself depends on
    // whether this checkout was paid by card (2.9%) or Link (2.7%).
    const pct = await resolveStripePct(rep.paymentIntentId, pmCache, pmCacheWrites, stripeLookupBudget);
    rep.stripeFee = round2((totalCharged + rep.processingFee) * pct + STRIPE_FIXED);
  }

  // Fold in top-up charges (admin "Add Player" / a late reschedule's charged
  // remainder — see registration_topup_charges) — each is a genuinely
  // separate, additional real Stripe charge with its own fee, independent
  // of whatever the original checkout's grouping above computed. This is
  // the permanent fix for the Bryan Schrubbe case: previously the second
  // charge was invisible to this sync entirely and needed a one-off manual
  // day-row correction; now it's picked up automatically every run.
  if (sessions.length > 0) {
    const { data: topups, error: topupsErr } = await supabase
      .from("registration_topup_charges")
      .select("registration_id, stripe_payment_intent_id, price_delta, service_fee")
      .in("registration_id", sessions.map((s) => s.registrationId));
    // A failed lookup here must NOT silently look identical to "no top-ups
    // exist" — that's exactly the class of gap that caused Bryan Schrubbe's
    // second charge to go uncounted in the first place, just one level
    // removed. Throwing surfaces it in the cron's error response instead of
    // quietly under-reporting fees with no signal anything's wrong.
    if (topupsErr) throw new Error(`registration_topup_charges query: ${topupsErr.message}`);
    const topupsByReg = new Map<string, { stripe_payment_intent_id: string; price_delta: number; service_fee: number }[]>();
    for (const t of (topups || []) as { registration_id: string; stripe_payment_intent_id: string; price_delta: number; service_fee: number }[]) {
      if (!topupsByReg.has(t.registration_id)) topupsByReg.set(t.registration_id, []);
      topupsByReg.get(t.registration_id)!.push(t);
    }
    for (const s of sessions) {
      const regTopups = topupsByReg.get(s.registrationId);
      if (!regTopups) continue;
      for (const t of regTopups) {
        s.processingFee = round2(s.processingFee + t.service_fee);
        const pct = await resolveStripePct(t.stripe_payment_intent_id, pmCache, pmCacheWrites, stripeLookupBudget);
        s.stripeFee = round2(s.stripeFee + (t.price_delta + t.service_fee) * pct + STRIPE_FIXED);
      }
    }
  }

  const { data: pkgSales, error: pkgErr } = await supabase
    .from("monthly_packages")
    .select("id, created_at, package_type, status, total_price, applied_account_credit, trainer_tier, parent_name, stripe_payment_intent_id")
    .in("status", ["active", "cancelled"])
    .gte("created_at", TRACKER_START_DATE);
  if (pkgErr) throw new Error(`monthly_packages query: ${pkgErr.message}`);
  const packages: DerivedPackage[] = [];
  for (const pkg of (pkgSales || []) as PackageRow[]) {
    const derived = derivePackage(pkg);
    if (derived) packages.push(derived);
  }
  // Same card-vs-Link correction as the session checkout groups above —
  // packages are always their own standalone checkout, so no grouping
  // needed, just a straight per-package lookup.
  for (const pkg of packages) {
    // amountCharged, not totalPrice — same reasoning as derivePackage above.
    if (!pkg.paymentIntentId || pkg.amountCharged <= 0) continue;
    const pct = await resolveStripePct(pkg.paymentIntentId, pmCache, pmCacheWrites, stripeLookupBudget);
    pkg.stripeFee = round2((pkg.amountCharged + pkg.processingFee) * pct + STRIPE_FIXED);
  }

  // Day-row edit protection (see the file header comment, textFingerprint,
  // and feeFingerprint) — read once, shared across every month built this
  // run, written back once at the end.
  await ensureDayLogTab();
  const dayLog = await readDayLog();
  const dayLogWrites = new Map<string, { text?: string; fee?: string }>();

  // Every month from TRACKER_START_DATE through the current month (ET).
  const monthsBuilt: string[] = [];
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [startY, startM] = TRACKER_START_DATE.split("-").map(Number);
  const [endY, endM] = todayET.split("-").map(Number);
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;
    const monthPackages = packages.filter((p) => p.date.startsWith(monthPrefix));
    await buildMonthTab(y, m, sessions, monthPackages, dayLog, dayLogWrites);
    monthsBuilt.push(monthTabName(y, m));
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  // Write back every text/fee fingerprint that was freshly (re)computed
  // this run — new keys get appended (always with both fields, since a
  // never-logged day is always unlocked on both counts), previously-logged
  // keys get ONLY the field(s) that were actually unlocked updated in
  // place, leaving the other column's stored value (and thus its lock)
  // completely untouched.
  const logUpdates: { range: string; values: unknown[][] }[] = [];
  const logNewRows: unknown[][] = [];
  for (const [key, entry] of dayLogWrites) {
    const existing = dayLog.get(key);
    if (existing) {
      if (entry.text !== undefined) logUpdates.push({ range: `${a1Quote(DAY_LOG_TAB)}!B${existing.row}`, values: [[entry.text]] });
      if (entry.fee !== undefined) logUpdates.push({ range: `${a1Quote(DAY_LOG_TAB)}!C${existing.row}`, values: [[entry.fee]] });
    } else {
      logNewRows.push([key, entry.text ?? "", entry.fee ?? ""]);
    }
  }
  if (logUpdates.length > 0) await batchUpdateValues(MONTHLY_REVENUE_SHEET_ID, logUpdates);
  if (logNewRows.length > 0) await appendValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(DAY_LOG_TAB)}!A:C`, logNewRows);

  // Payment-method cache only ever grows (a completed transaction's method
  // never changes) — every entry here is new, always append.
  if (pmCacheWrites.size > 0) {
    await appendValues(
      MONTHLY_REVENUE_SHEET_ID,
      `${a1Quote(PAYMENT_METHOD_CACHE_TAB)}!A:B`,
      Array.from(pmCacheWrites.entries()).map(([id, type]) => [id, type])
    );
  }

  return { monthsBuilt, sessionsConsidered: sessions.length, packagesConsidered: packages.length };
}
