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
 * bugs. Two exceptions, both real manual input that must survive a rebuild:
 * each month's per-location rent cell (see readExistingRent), and any day
 * row the owner has hand-edited (see the _DayLog tab / dayRowFingerprint
 * below) — a day is only ever rewritten if its live content still matches
 * the fingerprint of what THIS sync last wrote there; the moment it
 * diverges (a manual edit), that day is frozen forever and skipped on every
 * future run, and Month Totals is computed from its live (edited) values
 * instead of a freshly recomputed one. This does NOT extend to Trainer Pay
 * by Week or Location Breakdown below — those still always recompute
 * straight from the database regardless of any day-row edit, since they
 * need per-session detail a hand-edited day cell can't reliably provide
 * (confirmed acceptable with the owner).
 *
 * Trainer pay is computed here in code from the exact rate constants
 * captured live from the payroll sheet's own Settings tab (2026-08-08) —
 * see RATES below — rather than depending on that sheet's formulas, since
 * this is a fully separate document.
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeDate } from "./calendar";
import { calcServiceFee } from "./pricing";
import { getStripe } from "./stripe";
import { a1Quote, appendValues, batchUpdate, batchUpdateValues, getSheetMeta, getValues, updateValues } from "./sheets-write";

export const MONTHLY_REVENUE_SHEET_ID = "1_gSXvi7wXRdLZA2wMuiCwwublyBvUbCMrbJkUnUdaug";
const TRACKER_START_DATE = "2026-08-01";

const SUB_TRAINERS = [
  "Joseph Owens",
  "Zhaneia Thybulle",
  "Steven Papadimitropoulos",
  "Tristan Wissemann",
  "Zain Amjad",
] as const;
const OWNER_NAME = "Artemios Gavalas";

type RgbColor = { red: number; green: number; blue: number };

const TRAINER_COLOR: Record<string, RgbColor> = {
  [OWNER_NAME]: { red: 0.1, green: 0.1, blue: 0.1 },
  "Joseph Owens": { red: 0.11, green: 0.31, blue: 0.85 },
  "Zhaneia Thybulle": { red: 0.86, green: 0.15, blue: 0.34 },
  "Steven Papadimitropoulos": { red: 0.13, green: 0.55, blue: 0.25 },
  "Tristan Wissemann": { red: 0.55, green: 0.25, blue: 0.75 },
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
const STRIPE_PCT_CARD = 0.029;
const STRIPE_PCT_LINK = 0.027; // Stripe charges a lower % when the customer pays via Link instead of a plain card
const STRIPE_FIXED = 0.3; // same fixed $0.30 for both

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
  return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`);
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
  totalPrice: number; // counted as real Gross Revenue on this date — see deriveSession's grossRevenue=0 for package-covered sessions for why this can't also be counted again per-session later
  processingFee: number;
  stripeFee: number; // default assumes a card payment; the payment-method-aware post-pass in runMonthlyRevenueSync overrides this for Link
  paymentIntentId: string | null;
}

function derivePackage(pkg: PackageRow): DerivedPackage | null {
  const date = pkg.created_at ? pkg.created_at.slice(0, 10) : "";
  if (!date || date < TRACKER_START_DATE) return null;
  const price = pkg.total_price ?? 0;
  const processingFee = price > 0 ? calcServiceFee(price) : 0;
  // Stripe's 2.9%+$0.30 (card) is charged on the TOTAL amount that actually
  // hits the card — price PLUS the service-fee surcharge added on top at
  // checkout — not on the package price alone. Defaults to the card rate;
  // overridden below for Link payments (2.7%+$0.30).
  const stripeFee = price > 0 ? round2((price + processingFee) * STRIPE_PCT_CARD + STRIPE_FIXED) : 0;
  const size = pkg.package_type === 8 ? "8-Pack" : "4-Pack";
  const buyer = pkg.parent_name || "Unknown";
  return { date, label: `${buyer} — ${size} $${price.toFixed(2)}`, totalPrice: price, processingFee, stripeFee, paymentIntentId: pkg.stripe_payment_intent_id };
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

async function readExistingRent(tabName: string, rowIndex1: number): Promise<number | null> {
  const vals = await getValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(tabName)}!B${rowIndex1}`);
  const v = vals?.[0]?.[0];
  return typeof v === "number" ? v : null;
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
  fingerprint: string;
}

async function ensureDayLogTab(): Promise<void> {
  const meta = await getSheetMeta(MONTHLY_REVENUE_SHEET_ID);
  if (meta.some((s) => s.title === DAY_LOG_TAB)) return;
  await batchUpdate(MONTHLY_REVENUE_SHEET_ID, [
    { addSheet: { properties: { title: DAY_LOG_TAB, hidden: true } } },
  ]);
  await updateValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(DAY_LOG_TAB)}!A1:B1`, [["key", "fingerprint"]]);
}

async function readDayLog(): Promise<Map<string, DayLogEntry>> {
  const rows = await getValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(DAY_LOG_TAB)}!A2:B`);
  const map = new Map<string, DayLogEntry>();
  rows.forEach((r, i) => {
    const [key, fingerprint] = r as [string, string];
    if (!key) return;
    map.set(key, { row: i + 2, fingerprint: fingerprint || "" });
  });
  return map;
}

/** Fingerprints the fields a day's row can show that are genuinely
 * independent facts — the session list text, Place, and the 2 fee columns.
 * Gross Revenue and Net Revenue are deliberately excluded: they're always
 * DERIVED (Gross by summing every "$X.XX" in the session text, Net as
 * Gross+Processing-Stripe — see the locked branch in buildMonthTab) rather
 * than something to independently lock, so editing the session list alone
 * (e.g. removing a line) is enough to correct Gross without also having to
 * hand-recompute it. Date/Day (A:B) are never user-editable in practice so
 * they're excluded too. */
function dayRowFingerprint(
  privateText: string,
  groupText: string,
  place: string,
  processing: number,
  stripe: number
): string {
  return JSON.stringify([privateText, groupText, place, processing, stripe]);
}

/** Sums every "$X.XX" (or "$X,XXX.XX") dollar figure found in a block of
 * text — used to re-derive a locked day's Gross Revenue straight from
 * whatever the owner's session-list text currently says, instead of a
 * frozen number that can silently drift out of sync with an edit. */
function parseDollarSum(text: string): number {
  const matches = text.match(/\$([\d,]+\.\d{2})/g) || [];
  return round2(matches.reduce((sum, m) => sum + parseFloat(m.replace(/[$,]/g, "")), 0));
}

// ---------------------------------------------------------------------------
// Card vs Link payment-method lookup — Stripe charges a lower % on Link
// (2.7%+$0.30) than a plain card (2.9%+$0.30). Which one a given checkout
// actually used isn't stored anywhere in Supabase, only on the Stripe
// PaymentIntent itself, so this looks it up live and caches the result in a
// hidden tab keyed by payment_intent_id — a completed transaction's payment
// method never changes, so once looked up it never needs re-fetching.
// ---------------------------------------------------------------------------

const PAYMENT_METHOD_CACHE_TAB = "_PaymentMethodCache";
// Bounds how many NEW (uncached) Stripe lookups happen in a single run —
// the sync has a 60s function timeout, and each lookup is a real network
// call. Any payment intent that doesn't fit this run's budget falls back to
// the card rate for now and gets looked up (and corrected) on a later run.
const MAX_STRIPE_LOOKUPS_PER_RUN = 40;

async function ensurePaymentMethodCacheTab(): Promise<void> {
  const meta = await getSheetMeta(MONTHLY_REVENUE_SHEET_ID);
  if (meta.some((s) => s.title === PAYMENT_METHOD_CACHE_TAB)) return;
  await batchUpdate(MONTHLY_REVENUE_SHEET_ID, [
    { addSheet: { properties: { title: PAYMENT_METHOD_CACHE_TAB, hidden: true } } },
  ]);
  await updateValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(PAYMENT_METHOD_CACHE_TAB)}!A1:B1`, [["payment_intent_id", "method_type"]]);
}

async function readPaymentMethodCache(): Promise<Map<string, string>> {
  const rows = await getValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(PAYMENT_METHOD_CACHE_TAB)}!A2:B`);
  const map = new Map<string, string>();
  for (const r of rows) {
    const [id, type] = r as [string, string];
    if (id) map.set(id, type || "card");
  }
  return map;
}

function stripePctForMethod(methodType: string): number {
  return methodType === "link" ? STRIPE_PCT_LINK : STRIPE_PCT_CARD;
}

/** Resolves the real Stripe % for a payment intent — cached first, else a
 * live lookup (budget-limited), else falls back to the card rate. */
async function resolveStripePct(
  paymentIntentId: string | null,
  cache: Map<string, string>,
  cacheWrites: Map<string, string>,
  budget: { remaining: number }
): Promise<number> {
  if (!paymentIntentId) return STRIPE_PCT_CARD;
  const cached = cache.get(paymentIntentId);
  if (cached) return stripePctForMethod(cached);
  if (budget.remaining <= 0) return STRIPE_PCT_CARD; // picked up on a future run instead
  budget.remaining--;
  try {
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
    const methodType = typeof pi.payment_method === "object" && pi.payment_method ? pi.payment_method.type : "card";
    cache.set(paymentIntentId, methodType);
    cacheWrites.set(paymentIntentId, methodType);
    return stripePctForMethod(methodType);
  } catch {
    // Unretrievable (bad id, test-mode leftover, transient error) — default
    // to card rather than fail the whole sync over one fee refinement.
    return STRIPE_PCT_CARD;
  }
}

async function buildMonthTab(
  year: number,
  month1: number,
  sessions: DerivedSession[],
  packages: DerivedPackage[],
  dayLog: Map<string, DayLogEntry>,
  dayLogWrites: Map<string, string>
): Promise<void> {
  const tabName = monthTabName(year, month1);
  const sheetId = await ensureMonthTab(tabName);
  const nDays = daysInMonth(year, month1);
  const monthPrefix = `${year}-${String(month1).padStart(2, "0")}`;
  // One batched read of every day-row's live C:I content, so we can detect
  // a manual edit (live content diverging from what we last wrote) without
  // one getValues call per day.
  const liveDayRows = await getValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(tabName)}!C9:I${8 + nDays}`);

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

  const dayRowRequests: object[] = [];
  for (let d = 1; d <= nDays; d++) {
    const dateStr = `${monthPrefix}-${String(d).padStart(2, "0")}`;
    const dayName = new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
    // Chronological within the day, not insertion order — ties (two
    // trainers running sessions at the same start time) keep whatever
    // relative order they arrived in, which is fine per instruction.
    const daySessions = (sessionsByDate.get(dateStr) || []).slice().sort((a, b) => a.startHours - b.startHours);

    const privateSegs: TextSegment[] = [];
    const groupSegs: TextSegment[] = [];
    const places = new Set<string>();
    let gGross = 0, gProcessing = 0, gStripe = 0;

    daySessions.forEach((s) => {
      // Numbered within its own column (Private vs Group), not across the
      // combined day list — otherwise a day with 2 group sessions before 1
      // private session mislabels the lone private entry "3." instead of
      // "1.", which is exactly what a spot-check on 2026-08-07 caught.
      const n = (s.isGroupColumn ? groupSegs.length : privateSegs.length) + 1;
      const seg: TextSegment = { text: `${n}. ${s.label}`, color: s.isCamp ? CAMP_COLOR : TRAINER_COLOR[s.trainer] || CAMP_COLOR };
      if (s.isGroupColumn) groupSegs.push(seg); else privateSegs.push(seg);
      if (s.location) places.add(s.location);
      gGross += s.grossRevenue;
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
      gGross += p.totalPrice;
      gProcessing += p.processingFee;
      gStripe += p.stripeFee;
    }

    const rowIndex0 = 8 + (d - 1); // header is row index 7 (row 8, 1-indexed)
    const rowNum1 = rowIndex0 + 1; // 1-indexed, for building formula strings
    const privateCell = privateSegs.length > 0 ? richTextCellData(privateSegs) : null;
    const groupCell = groupSegs.length > 0 ? richTextCellData(groupSegs) : null;
    const placesStr = Array.from(places).join(" / ");

    // Locked = this day's session-list text or fee cells no longer match
    // what THIS sync last wrote there — i.e. the owner hand-edited one of
    // them since. A never-logged day (dayLog has no entry) is treated as
    // unlocked: either it's brand new, or it's an already-existing day from
    // before this protection existed, which gets one final overwrite here
    // and is logged/protected from then on.
    const logKey = `${tabName}|${dateStr}`;
    const stored = dayLog.get(logKey);
    const freshFingerprint = dayRowFingerprint(
      privateCell?.stringValue ?? "",
      groupCell?.stringValue ?? "",
      placesStr,
      gProcessing,
      gStripe
    );
    let locked = false;
    if (stored) {
      const liveRow = liveDayRows[d - 1] || [];
      // Fingerprint format changed (Gross/Net dropped, since those are now
      // always derived rather than lockable — see dayRowFingerprint) —
      // entries logged before that change are a 7-element array. Comparing
      // those against the old 7-field shape one more time (rather than
      // treating them as "never logged") is what keeps an already-locked
      // day like a hand-corrected fee actually staying locked through this
      // transition, instead of getting one unwanted final overwrite.
      let storedLen = 0;
      try {
        storedLen = (JSON.parse(stored.fingerprint) as unknown[]).length;
      } catch {
        storedLen = 0;
      }
      const liveFingerprint = storedLen === 7
        ? JSON.stringify([
            String(liveRow[0] ?? ""), String(liveRow[1] ?? ""), String(liveRow[2] ?? ""),
            Number(liveRow[3]) || 0, Number(liveRow[4]) || 0, Number(liveRow[5]) || 0, Number(liveRow[6]) || 0,
          ])
        : dayRowFingerprint(
            String(liveRow[0] ?? ""),
            String(liveRow[1] ?? ""),
            String(liveRow[2] ?? ""),
            Number(liveRow[4]) || 0,
            Number(liveRow[5]) || 0
          );
      locked = liveFingerprint !== stored.fingerprint;
    }

    // Net Revenue (I) is ALWAYS a formula, =F+G-H, for every day row
    // regardless of lock status — it's genuinely just arithmetic on 3 other
    // cells already on the sheet, so it self-updates the instant the owner
    // edits Gross, Processing, or Stripe directly, with no sync needed.
    const netFormula = `=F${rowNum1}+G${rowNum1}-H${rowNum1}`;

    if (locked) {
      // Gross Revenue is re-derived straight from the live session-list
      // text (summing every "$X.XX" it contains) rather than trusting a
      // frozen number — so removing/editing a line item is, by itself,
      // enough to correct the total; nothing gets silently missed just
      // because only the text was touched. Processing/Stripe Fee stay
      // exactly whatever the owner left them at (they aren't derivable from
      // the text).
      const liveRow = liveDayRows[d - 1] || [];
      const liveGross = round2(parseDollarSum(String(liveRow[0] ?? "")) + parseDollarSum(String(liveRow[1] ?? "")));

      // Only Gross (F) and Net (I) get rewritten — Date/Day/session
      // text/Place/Processing/Stripe (A,B,C,D,E,G,H) are the owner's
      // protected domain and are never touched once locked.
      requests.push({
        updateCells: {
          rows: [{ values: [{ userEnteredValue: { numberValue: liveGross }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }] }],
          fields: "userEnteredValue,userEnteredFormat",
          start: { sheetId, rowIndex: rowIndex0, columnIndex: 5 },
        },
      });
      requests.push({
        updateCells: {
          rows: [{ values: [{ userEnteredValue: { formulaValue: netFormula }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }] }],
          fields: "userEnteredValue,userEnteredFormat",
          start: { sheetId, rowIndex: rowIndex0, columnIndex: 8 },
        },
      });
    } else {
      dayLogWrites.set(logKey, freshFingerprint);

      // WRAP explicitly — otherwise Sheets' default wrap strategy only
      // auto-expands row height inconsistently (observed live: a day with 9
      // combined lines expanded fine, one with only 2-3 got clipped).
      const wrapFormat = { wrapStrategy: "WRAP" };
      dayRowRequests.push({
        updateCells: {
          rows: [
            {
              values: [
                { userEnteredValue: { stringValue: dateStr } },
                { userEnteredValue: { stringValue: dayName } },
                privateCell
                  ? { userEnteredValue: { stringValue: privateCell.stringValue }, textFormatRuns: privateCell.textFormatRuns, userEnteredFormat: wrapFormat }
                  : { userEnteredValue: { stringValue: "" } },
                groupCell
                  ? { userEnteredValue: { stringValue: groupCell.stringValue }, textFormatRuns: groupCell.textFormatRuns, userEnteredFormat: wrapFormat }
                  : { userEnteredValue: { stringValue: "" } },
                { userEnteredValue: { stringValue: placesStr } },
                { userEnteredValue: { numberValue: gGross }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
                { userEnteredValue: { numberValue: gProcessing }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
                { userEnteredValue: { numberValue: gStripe }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
                { userEnteredValue: { formulaValue: netFormula }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
              ],
            },
          ],
          fields: "userEnteredValue,userEnteredFormat,textFormatRuns",
          start: { sheetId, rowIndex: rowIndex0, columnIndex: 0 },
        },
      });
    }
  }
  requests.push(...dayRowRequests);

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
  for (const loc of KNOWN_LOCATIONS) {
    const existingRent = await readExistingRent(tabName, row0 + 1); // 1-indexed row for getValues
    const rent = existingRent ?? loc.monthlyRent;
    const locRowNum1 = row0 + 1;
    requests.push({
      updateCells: {
        rows: [{
          values: [
            { userEnteredValue: { stringValue: loc.name } },
            { userEnteredValue: { numberValue: rent } },
            { userEnteredValue: { formulaValue: `=SUMIF(E${firstDayRow1}:E${lastDayRow1},"*"&A${locRowNum1}&"*",F${firstDayRow1}:F${lastDayRow1})` } },
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
          { userEnteredValue: { formulaValue: `=F${totalsRow1}-SUM(C${firstLocRow1}:C${lastLocRow1})` } },
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
            userEnteredValue: { formulaValue: `=I${totalsRow1}-${trainerGrandTotalCell}-SUM(B${firstLocRow1}:B${lastLocRow1})` },
            userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, ...currencyFmt },
          },
          { userEnteredValue: { stringValue: "= Net Revenue − Trainer Pay − Rent" } },
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
  await ensurePaymentMethodCacheTab();
  const pmCache = await readPaymentMethodCache();
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

  const { data: pkgSales, error: pkgErr } = await supabase
    .from("monthly_packages")
    .select("id, created_at, package_type, status, total_price, trainer_tier, parent_name, stripe_payment_intent_id")
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
    if (!pkg.paymentIntentId || pkg.totalPrice <= 0) continue;
    const pct = await resolveStripePct(pkg.paymentIntentId, pmCache, pmCacheWrites, stripeLookupBudget);
    pkg.stripeFee = round2((pkg.totalPrice + pkg.processingFee) * pct + STRIPE_FIXED);
  }

  // Day-row edit protection (see the file header comment and
  // dayRowFingerprint) — read once, shared across every month built this
  // run, written back once at the end.
  await ensureDayLogTab();
  const dayLog = await readDayLog();
  const dayLogWrites = new Map<string, string>();

  // Every month from TRACKER_START_DATE through the current month (ET).
  const monthsBuilt: string[] = [];
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [startY, startM] = TRACKER_START_DATE.split("-").map(Number);
  const [endY, endM] = todayET.split("-").map(Number);
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;
    const monthSessions = sessions.filter((s) => s.date.startsWith(monthPrefix));
    const monthPackages = packages.filter((p) => p.date.startsWith(monthPrefix));
    await buildMonthTab(y, m, sessions, monthPackages, dayLog, dayLogWrites);
    monthsBuilt.push(monthTabName(y, m));
    void monthSessions;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  // Write back every day that was (re)generated this run — new keys get
  // appended, previously-logged keys get updated in place.
  const logUpdates: { range: string; values: unknown[][] }[] = [];
  const logNewRows: unknown[][] = [];
  for (const [key, fingerprint] of dayLogWrites) {
    const existing = dayLog.get(key);
    if (existing) {
      logUpdates.push({ range: `${a1Quote(DAY_LOG_TAB)}!B${existing.row}`, values: [[fingerprint]] });
    } else {
      logNewRows.push([key, fingerprint]);
    }
  }
  if (logUpdates.length > 0) await batchUpdateValues(MONTHLY_REVENUE_SHEET_ID, logUpdates);
  if (logNewRows.length > 0) await appendValues(MONTHLY_REVENUE_SHEET_ID, `${a1Quote(DAY_LOG_TAB)}!A:B`, logNewRows);

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
