/**
 * Syncs confirmed/no-show/late-cancelled bookings from Supabase into the
 * "Mesa Basketball Training LLC - Payroll and Revenue Tracker" Google Sheet,
 * so the trainer tabs no longer need to be filled in by hand.
 *
 * Design notes (see conversation / PR description for the full reasoning):
 * - Only writes the RAW INPUT columns a human would otherwise type
 *   (date, session type, participants, times, payment type, package size,
 *   discount, credit applied, cancellation flag). Every other column on the
 *   trainer tabs is a formula and is left completely alone — it keeps
 *   calculating off whatever this script writes, exactly like manual entry.
 * - New rows are created by cloning row 4 (copyPaste) onto the next empty
 *   row before writing values into it, so the clone picks up that row's
 *   formulas, dropdown validation, and conditional-formatting membership —
 *   identical to a human selecting row 4, copying it, and pasting it down.
 * - A hidden "_SyncLog" tab tracks registration_id -> (trainer tab, row)
 *   so reruns update the same row instead of duplicating it, and so a
 *   status change after the fact (e.g. confirmed -> no_show) rewrites the
 *   existing row rather than creating a second one.
 * - Camp bookings are out of scope entirely (the sheet has no concept of
 *   camp pay) and non-late cancellations are skipped (no compensable work
 *   happened, and the sheet's own spec never logs those as a row).
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeDate } from "./calendar";
import {
  a1Quote,
  appendValues,
  batchUpdate,
  batchUpdateValues,
  copyRow,
  getSheetMeta,
  getValues,
  updateValues,
} from "./sheets-write";
import { calcServiceFee } from "./pricing";
import {
  STRIPE_FIXED,
  PAYMENT_METHOD_CACHE_TAB,
  ensurePaymentMethodCacheTab,
  readPaymentMethodCache,
  resolvePaymentMethod,
  MAX_STRIPE_LOOKUPS_PER_RUN,
} from "./stripe-payment-method";

// ---------------------------------------------------------------------------
// Constants mirroring the sheet's own layout (build_mesa_sheet.py) and the
// site's own pricing constants (src/lib/pricing.ts, "other" tier).
// ---------------------------------------------------------------------------

const TRAINERS = [
  "Joseph Owens",
  "Zhaneia Thybulle",
  "Steven Papadimitropoulos",
  "Tristan Wissemann",
  "Zain Amjad",
] as const;

/** Case/whitespace-insensitive match, since the trainer name that ends up on
 * a booking is whatever gets typed into the schedule spreadsheet's Trainer
 * column by hand — a stray capitalization or double space shouldn't cause a
 * real trainer's sessions to silently fall into "unknown trainer". Maps a
 * normalized form back to the sheet's canonical tab-name spelling. */
function normalizeTrainerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
const TRAINER_BY_NORMALIZED = new Map(TRAINERS.map((t) => [normalizeTrainerName(t), t]));

const TRAINER_FIRST_ROW = 4; // fixed forever — never changes as rows are added
const TRAINER_NUM_COLS = 27; // A:AA

const PSL_TAB = "Package Sales Log";
const PSL_FIRST_ROW = 5;
const PSL_NUM_COLS = 9; // A:I

const SYNC_LOG_TAB = "_SyncLog";

const GROUP_CLIENT_RATE = 50; // $/participant/hour, "weekly" group sessions
const DISCOUNT_TIERS = [0.15, 0.1, 0]; // checked in this order (largest first)

// Per-run safety cap so a large historical backlog on the very first run
// can't blow through the serverless function's time limit — remaining rows
// simply get picked up on the next scheduled run since already-synced rows
// are cheap to skip.
const MAX_WRITES_PER_RUN = 150;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Supabase — a small dedicated client, deliberately not importing from
// src/lib/supabase.ts, so this new/still-settling code can never affect the
// site's own working DB access.
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

interface RegistrationRow {
  id: string;
  parent_name: string;
  email: string;
  type: string;
  total_participants: number;
  booked_date: string | null;
  booked_start_time: string | null;
  booked_end_time: string | null;
  booked_trainer: string | null;
  status: string;
  session_price: number | null;
  applied_account_credit: number | null;
  package_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
}

interface TopupChargeRow {
  registration_id: string;
  stripe_payment_intent_id: string;
  price_delta: number;
  service_fee: number;
}

interface MonthlyPackageRow {
  id: string;
  created_at: string;
  package_type: number;
  status: string;
  total_price: number | null;
  trainer_tier: string | null;
}

interface LateFeeEventRow {
  registration_id: string;
  action: "cancel" | "reschedule";
}

// ---------------------------------------------------------------------------
// Time/date helpers
// ---------------------------------------------------------------------------

/** Sheets' USER_ENTERED parser handles both "18:00" and "6:00 PM" fine, but
 * normalizing to 12-hour keeps written rows visually consistent with rows a
 * human typed by hand. */
function normalizeTime(raw: string | null): string {
  if (!raw) return "";
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return raw.trim(); // already "6:00 PM"-style or unrecognized — pass through
  let h = parseInt(m[1], 10);
  const min = m[2];
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${suffix}`;
}

/** "H:MM AM/PM" or "HH:MM" -> hours since midnight (e.g. "6:30 PM" -> 18.5). */
function timeToDecimalHours(t: string | null): number | null {
  if (!t) return null;
  const norm = normalizeTime(t);
  const m = norm.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const suffix = m[3]?.toUpperCase();
  if (suffix === "PM" && h !== 12) h += 12;
  if (suffix === "AM" && h === 12) h = 0;
  return h + min / 60;
}

/** Decimal hours between two times, for the discount-inference math. */
function hoursBetween(start: string | null, end: string | null): number | null {
  const s = timeToDecimalHours(start);
  const e = timeToDecimalHours(end);
  if (s === null || e === null) return null;
  return Math.round((e - s) * 100) / 100;
}

/** Wall-clock Date for when a booked session ends, in the site's home timezone. */
function sessionEndDateTime(dateStr: string, endTime: string | null): Date | null {
  const endHours = timeToDecimalHours(endTime);
  if (endHours === null) return null;
  const h = Math.floor(endHours);
  const min = Math.round((endHours - h) * 60);
  // Constructing via a local-timezone string keeps this consistent with how
  // the rest of the site reasons about booked_date/booked_*_time (plain wall
  // clock, no explicit UTC offset stored) — see calendar.ts's TIMEZONE use.
  return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`);
}

// ---------------------------------------------------------------------------
// _SyncLog bookkeeping
// ---------------------------------------------------------------------------

interface SyncLogEntry {
  key: string; // registration id, or "pkg:<monthly_package id>"
  tab: string; // trainer tab name, or PSL_TAB
  row: number; // 1-indexed row in that tab
  // Last-written fingerprint (see deriveRowFingerprint) for a registration
  // row, or the literal string "purchased" for a package row (packages
  // never change after the fact, so no fingerprint is needed there).
  status: string;
}

/** Serializes every field actually WRITTEN to the sheet (not just the
 * cancellation flag) so a rerun can tell whether anything relevant changed
 * since the last sync, not just whether the flag changed. Without this, a
 * post-completion correction — e.g. admin "Add Player" retroactively
 * changing participants/price on an already-"Completed" row, since that
 * route only guards on status === "confirmed", never on whether the
 * session date has already passed — would silently never re-sync: the flag
 * reads "Completed" before and after, so a flag-only check treats it as
 * "already synced, unchanged" and skips it forever, permanently
 * understating that trainer's pay in the Sheet with no visible sign
 * anything's wrong. */
function deriveRowFingerprint(r: DerivedRow): string {
  return JSON.stringify([
    r.cancellationFlag, r.participants, r.startTime, r.endTime,
    r.paymentType, r.packageSize, r.discount, r.creditApplied,
    // processingFee/stripeFee are filled in by a later pass (checkout-session
    // grouping, top-up folding) — including them here means a fee correction
    // that arrives on its own (e.g. a top-up charge logged the day AFTER the
    // original session already synced) is enough, by itself, to trigger a
    // re-write of this row, same reasoning as the comment above.
    r.processingFee, r.stripeFee,
  ]);
}

async function ensureSyncLogTab(spreadsheetId: string): Promise<void> {
  const meta = await getSheetMeta(spreadsheetId);
  if (meta.some((s) => s.title === SYNC_LOG_TAB)) return;
  await batchUpdate(spreadsheetId, [
    { addSheet: { properties: { title: SYNC_LOG_TAB, hidden: true } } },
  ]);
  await updateValues(spreadsheetId, `${a1Quote(SYNC_LOG_TAB)}!A1:D1`, [
    ["key", "tab", "row", "status"],
  ]);
}

async function readSyncLog(spreadsheetId: string): Promise<Map<string, SyncLogEntry>> {
  const rows = await getValues(spreadsheetId, `${a1Quote(SYNC_LOG_TAB)}!A2:D`);
  const map = new Map<string, SyncLogEntry>();
  for (const r of rows) {
    const [key, tab, row, status] = r as [string, string, number, string];
    if (!key) continue;
    map.set(key, { key, tab, row: Number(row), status: status || "" });
  }
  return map;
}

/** Highest row already used per tab, from the log — so new rows are appended
 * after the last known one without re-scanning every trainer tab. */
function maxRowPerTab(log: Map<string, SyncLogEntry>): Map<string, number> {
  const max = new Map<string, number>();
  for (const entry of log.values()) {
    max.set(entry.tab, Math.max(max.get(entry.tab) ?? 0, entry.row));
  }
  return max;
}

// ---------------------------------------------------------------------------
// Row derivation: DB registration -> the 10 raw input columns the sheet expects
// ---------------------------------------------------------------------------

type CancellationFlag =
  | "Completed"
  | "Cancellation within 24 hours"
  | "Late Reschedule within 24 hours"
  | "No Show"
  | null; // null = skip entirely, nothing to log

function deriveCancellationFlag(
  reg: RegistrationRow,
  lateFeeAction: "cancel" | "reschedule" | undefined
): CancellationFlag {
  if (reg.status === "no_show") return "No Show";
  if (reg.status === "confirmed") {
    if (!reg.booked_date) return null; // can't tell if it's happened yet
    // booked_date is stored as whatever raw format the schedule sheet
    // happened to export at booking time (e.g. "August 9, 2026"), never
    // normalized to ISO at write time — sessionEndDateTime's `${date}T...`
    // construction silently produces an Invalid Date without this, which
    // made `end.getTime() < Date.now()` permanently false (NaN comparisons
    // are always false) and meant this branch could never return
    // "Completed" for ANY confirmed session, regardless of how long ago it
    // actually happened. Same underlying bug already found and fixed in
    // monthly-revenue-sync.ts's deriveSession and reminder-emails.ts — this
    // file had its own independent, unfixed copy of the same pattern.
    const end = sessionEndDateTime(normalizeDate(reg.booked_date), reg.booked_end_time);
    if (!end) return null;
    return end.getTime() < Date.now() ? "Completed" : null; // still upcoming — nothing to log yet
  }
  if (reg.status === "cancelled") {
    // is_late_cancel is not on this narrowed type; caller only passes
    // cancelled rows here when is_late_cancel was true (see query below).
    return lateFeeAction === "reschedule"
      ? "Late Reschedule within 24 hours"
      : "Cancellation within 24 hours";
  }
  return null; // pending_payment / payment_abandoned / anything else — never booked
}

interface DerivedRow {
  date: string;
  sessionType: "Group" | "Private";
  participants: number;
  startTime: string;
  endTime: string;
  paymentType: "Credit Card" | "Link" | "Credit Only" | "Package (Prepaid)";
  packageSize: "4-Pack" | "8-Pack" | "";
  discount: number;
  creditApplied: number;
  cancellationFlag: CancellationFlag;
  notes: string;
  // The real amount actually run through Stripe for this row (post-credit,
  // $0 for package-covered/credit-only rows) — NOT yet a fee. Used by the
  // checkout-session-grouping post-pass in runPayrollSync (mirrors
  // monthly-revenue-sync.ts's stripePortion) since a single checkout can
  // cover several registration rows and the service/Stripe fee is only
  // charged once per checkout, not once per row.
  stripePortion: number;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  // Filled in by the post-pass in runPayrollSync — 0 until then. Written to
  // the sheet as raw values (Q/S), not left as per-row formulas, since the
  // real fee genuinely depends on cross-row (checkout-grouping) and
  // external (registration_topup_charges) knowledge a single row's own
  // cells can't derive.
  processingFee: number;
  stripeFee: number;
}

function deriveRow(
  reg: RegistrationRow,
  lateFeeAction: "cancel" | "reschedule" | undefined,
  packageType: number | null
): DerivedRow | null {
  const cancellationFlag = deriveCancellationFlag(reg, lateFeeAction);
  if (!cancellationFlag) return null;
  if (!reg.booked_date || !reg.booked_start_time || !reg.booked_end_time) return null;

  const sessionType: "Group" | "Private" = reg.type === "weekly" ? "Group" : "Private";
  const participants = reg.total_participants || 1;
  const hours = hoursBetween(reg.booked_start_time, reg.booked_end_time) ?? 0;
  const credit = reg.applied_account_credit || 0;
  const price = reg.session_price ?? 0;

  let paymentType: DerivedRow["paymentType"] = "Credit Card";
  let packageSize: DerivedRow["packageSize"] = "";
  if (reg.package_id) {
    paymentType = "Package (Prepaid)";
    packageSize = packageType === 8 ? "8-Pack" : "4-Pack";
  } else if (credit > 0 && credit >= price) {
    paymentType = "Credit Only";
  }
  // "Link" (vs the "Credit Card" default set above) is only ever resolved
  // later, in runPayrollSync's checkout-grouping post-pass — this function
  // has no Stripe access and stays synchronous.
  const stripePortion = paymentType === "Package (Prepaid)" || paymentType === "Credit Only"
    ? 0
    : Math.max(price - credit, 0);

  // Discount only applies to non-package Group (pay-as-you-go weekly) rows —
  // inferred by comparing the sheet's own pre-discount formula against what
  // was actually charged, since the live discount % isn't stored anywhere.
  let discount = 0;
  if (sessionType === "Group" && paymentType !== "Package (Prepaid)" && hours > 0) {
    const undiscounted = GROUP_CLIENT_RATE * participants * hours;
    if (undiscounted > 0) {
      const impliedPct = 1 - price / undiscounted;
      for (const tier of DISCOUNT_TIERS) {
        if (impliedPct >= tier - 0.02) {
          discount = tier;
          break;
        }
      }
    }
  }

  return {
    date: reg.booked_date,
    sessionType,
    participants,
    startTime: normalizeTime(reg.booked_start_time),
    endTime: normalizeTime(reg.booked_end_time),
    paymentType,
    packageSize,
    discount,
    creditApplied: credit,
    cancellationFlag,
    notes: `Auto-synced: ${reg.parent_name || reg.email || ""}`.trim(),
    stripePortion,
    checkoutSessionId: reg.stripe_checkout_session_id,
    paymentIntentId: reg.stripe_payment_intent_id,
    processingFee: 0,
    stripeFee: 0,
  };
}

/** The 12 input-column values, in A,C,D,E,F,J,K,M,O,Q,S,V,X sheet order
 * (skipping formula columns). Q (Processing Fee) and S (Stripe Fee) are
 * script-computed raw values (see DerivedRow's comment) — everything else
 * here is unchanged from before. */
function rowToInputValues(r: DerivedRow): { range: string; values: unknown[] }[] {
  return [
    { range: "A", values: [r.date] },
    { range: "C", values: [r.sessionType] },
    { range: "D", values: [r.participants] },
    { range: "E", values: [r.startTime] },
    { range: "F", values: [r.endTime] },
    { range: "J", values: [r.paymentType] },
    { range: "K", values: [r.packageSize] },
    { range: "M", values: [r.discount] },
    { range: "Q", values: [r.processingFee] },
    { range: "S", values: [r.stripeFee] },
    { range: "O", values: [r.creditApplied] },
    { range: "V", values: [r.cancellationFlag] },
    { range: "X", values: [r.notes] },
  ];
}

async function writeTrainerRow(
  spreadsheetId: string,
  tab: string,
  row: number,
  r: DerivedRow
): Promise<void> {
  // One batched request instead of one values.update per column — Sheets'
  // write-request quota is spent per HTTP call regardless of how many
  // cells it touches, so this is ~11 quota units down to 1 for every row.
  await batchUpdateValues(
    spreadsheetId,
    rowToInputValues(r).map(({ range, values }) => ({
      range: `${a1Quote(tab)}!${range}${row}`,
      values: [values],
    }))
  );
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

export interface PayrollSyncResult {
  sessionsConsidered: number;
  sessionsWritten: number;
  sessionsUpdated: number;
  sessionsSkippedUnknownTrainer: number;
  sessionsSkippedNoLoggableStatus: number;
  sessionsSkippedNonLateCancel: number;
  packagesConsidered: number;
  packagesWritten: number;
  packagesUpdated: number;
  errors: string[];
}

export async function runPayrollSync(): Promise<PayrollSyncResult> {
  const spreadsheetId = process.env.PAYROLL_SHEET_ID;
  if (!spreadsheetId) throw new Error("PAYROLL_SHEET_ID not configured");

  const supabase = getSupabase();

  // Claim the single-row lock before doing any real work — see
  // supabase-migration-payroll-sync-lock.sql for why. A stuck lock (crashed
  // mid-run before the finally below could release it) would permanently
  // block future runs, which is worse than the race it prevents — 10
  // minutes is far longer than a real run ever takes (maxDuration is 60s),
  // so a lock that old is treated as abandoned and stolen instead of
  // honored.
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: claimed } = await supabase
    .from("payroll_sync_lock")
    .update({ is_running: true, started_at: new Date().toISOString() })
    .eq("id", 1)
    .or(`is_running.eq.false,started_at.lt.${staleCutoff}`)
    .select("id");
  if (!claimed || claimed.length === 0) {
    return {
      sessionsConsidered: 0, sessionsWritten: 0, sessionsUpdated: 0,
      sessionsSkippedUnknownTrainer: 0, sessionsSkippedNoLoggableStatus: 0, sessionsSkippedNonLateCancel: 0,
      packagesConsidered: 0, packagesWritten: 0, packagesUpdated: 0,
      errors: ["Payroll sync already in progress — skipped to avoid interleaving writes."],
    };
  }

  try {
  const result: PayrollSyncResult = {
    sessionsConsidered: 0,
    sessionsWritten: 0,
    sessionsUpdated: 0,
    sessionsSkippedUnknownTrainer: 0,
    sessionsSkippedNoLoggableStatus: 0,
    sessionsSkippedNonLateCancel: 0,
    packagesConsidered: 0,
    packagesWritten: 0,
    packagesUpdated: 0,
    errors: [],
  };

  await ensureSyncLogTab(spreadsheetId);
  const log = await readSyncLog(spreadsheetId);
  const nextRow = maxRowPerTab(log);
  let writesThisRun = 0;

  // ---- sessions: registrations -> trainer tabs ----
  const { data: regs, error: regErr } = await supabase
    .from("registrations")
    .select(
      "id, parent_name, email, type, total_participants, booked_date, booked_start_time, booked_end_time, booked_trainer, status, session_price, applied_account_credit, package_id, stripe_checkout_session_id, stripe_payment_intent_id"
    )
    .in("type", ["weekly", "private", "group-private"])
    .in("status", ["confirmed", "cancelled", "no_show"])
    .not("booked_trainer", "is", null);
  if (regErr) {
    result.errors.push(`registrations query: ${regErr.message}`);
  }

  const registrations = (regs || []) as RegistrationRow[];
  result.sessionsConsidered = registrations.length;

  // Only fetch late_fee_events / packages for the registrations we're actually considering.
  const cancelledIds = registrations.filter((r) => r.status === "cancelled").map((r) => r.id);
  const packageIds = [...new Set(registrations.map((r) => r.package_id).filter(Boolean))] as string[];

  const lateFeeByReg = new Map<string, "cancel" | "reschedule">();
  if (cancelledIds.length > 0) {
    const { data: lateFeeEvents } = await supabase
      .from("late_fee_events")
      .select("registration_id, action")
      .in("registration_id", cancelledIds);
    for (const e of (lateFeeEvents || []) as LateFeeEventRow[]) {
      lateFeeByReg.set(e.registration_id, e.action);
    }
  }

  const packageTypeById = new Map<string, number>();
  if (packageIds.length > 0) {
    const { data: pkgs } = await supabase
      .from("monthly_packages")
      .select("id, package_type")
      .in("id", packageIds);
    for (const p of (pkgs || []) as { id: string; package_type: number }[]) {
      packageTypeById.set(p.id, p.package_type);
    }
  }

  // is_late_cancel matters for cancelled rows but wasn't selected above (not
  // in RegistrationRow) — re-check it via a targeted second pass only for
  // cancelled rows, since a non-late cancellation must be skipped entirely.
  const isLateCancelById = new Map<string, boolean>();
  if (cancelledIds.length > 0) {
    const { data: lateFlags } = await supabase
      .from("registrations")
      .select("id, is_late_cancel")
      .in("id", cancelledIds);
    for (const row of (lateFlags || []) as { id: string; is_late_cancel: boolean | null }[]) {
      isLateCancelById.set(row.id, !!row.is_late_cancel);
    }
  }

  // Pass 1: derive every in-scope row first (no Stripe calls, no writes) —
  // needed before the fee post-pass below, since a real Processing/Stripe
  // Fee depends on cross-row (checkout-session grouping) and external
  // (registration_topup_charges) knowledge a single registration can't
  // supply on its own.
  interface DerivedEntry { reg: RegistrationRow; trainer: string; derived: DerivedRow }
  const entries: DerivedEntry[] = [];
  for (const reg of registrations) {
    const trainer = TRAINER_BY_NORMALIZED.get(normalizeTrainerName(reg.booked_trainer || ""));
    if (!trainer) {
      result.sessionsSkippedUnknownTrainer++;
      continue;
    }
    if (reg.status === "cancelled" && !isLateCancelById.get(reg.id)) {
      // Non-late cancellation — no compensable work, spec says don't log it.
      result.sessionsSkippedNonLateCancel++;
      continue;
    }
    const derived = deriveRow(
      reg,
      lateFeeByReg.get(reg.id),
      reg.package_id ? packageTypeById.get(reg.package_id) ?? null : null
    );
    if (!derived) {
      result.sessionsSkippedNoLoggableStatus++;
      continue;
    }
    entries.push({ reg, trainer, derived });
  }

  // Pass 2: card-vs-Link resolution + checkout-session fee grouping — a
  // single Stripe Checkout can cover several registration rows (e.g. a
  // multi-date private series), and the ~$4.50/3.2% service fee plus the
  // real Stripe cost are charged/incurred ONCE per checkout, not once per
  // row. Mirrors monthly-revenue-sync.ts's checkoutGroups exactly — without
  // this, a multi-row checkout would have its processing fee counted once
  // per row instead of once for the whole checkout.
  await ensurePaymentMethodCacheTab(spreadsheetId);
  const pmCache = await readPaymentMethodCache(spreadsheetId);
  const pmCacheWrites = new Map<string, string>();
  const stripeLookupBudget = { remaining: MAX_STRIPE_LOOKUPS_PER_RUN };

  const checkoutGroups = new Map<string, DerivedEntry[]>();
  for (const entry of entries) {
    const csid = entry.reg.stripe_checkout_session_id;
    if (!csid || entry.derived.stripePortion <= 0) continue;
    if (!checkoutGroups.has(csid)) checkoutGroups.set(csid, []);
    checkoutGroups.get(csid)!.push(entry);
  }
  for (const group of checkoutGroups.values()) {
    const totalCharged = round2(group.reduce((sum, e) => sum + e.derived.stripePortion, 0));
    if (totalCharged <= 0) continue;
    const rep = group.slice().sort((a, b) =>
      (a.reg.booked_date || "").localeCompare(b.reg.booked_date || "") ||
      (timeToDecimalHours(a.reg.booked_start_time) ?? 0) - (timeToDecimalHours(b.reg.booked_start_time) ?? 0)
    )[0];
    rep.derived.processingFee = calcServiceFee(totalCharged);
    const { pct, label } = await resolvePaymentMethod(rep.reg.stripe_payment_intent_id, pmCache, pmCacheWrites, stripeLookupBudget);
    rep.derived.stripeFee = round2((totalCharged + rep.derived.processingFee) * pct + STRIPE_FIXED);
    // Only ever upgrades the plain-card default to "Link" — never touches
    // "Credit Only"/"Package (Prepaid)", which were never card-charged.
    if (rep.derived.paymentType === "Credit Card") rep.derived.paymentType = label;
  }

  // Pass 3: fold in top-up charges (admin "Add Player" / a late reschedule's
  // charged remainder — see registration_topup_charges) — each is a
  // genuinely separate, additional real Stripe charge with its own fee,
  // independent of whatever the original checkout's grouping above computed.
  if (entries.length > 0) {
    const { data: topups, error: topupsErr } = await supabase
      .from("registration_topup_charges")
      .select("registration_id, stripe_payment_intent_id, price_delta, service_fee")
      .in("registration_id", entries.map((e) => e.reg.id));
    // A failed lookup here must NOT silently look identical to "no top-ups
    // exist" — under-reporting a real fee with no signal anything's wrong
    // is exactly the class of gap this table exists to close.
    if (topupsErr) result.errors.push(`registration_topup_charges query: ${topupsErr.message}`);
    const topupsByReg = new Map<string, TopupChargeRow[]>();
    for (const t of (topups || []) as TopupChargeRow[]) {
      if (!topupsByReg.has(t.registration_id)) topupsByReg.set(t.registration_id, []);
      topupsByReg.get(t.registration_id)!.push(t);
    }
    for (const entry of entries) {
      const regTopups = topupsByReg.get(entry.reg.id);
      if (!regTopups) continue;
      for (const t of regTopups) {
        entry.derived.processingFee = round2(entry.derived.processingFee + t.service_fee);
        const { pct } = await resolvePaymentMethod(t.stripe_payment_intent_id, pmCache, pmCacheWrites, stripeLookupBudget);
        entry.derived.stripeFee = round2(entry.derived.stripeFee + (t.price_delta + t.service_fee) * pct + STRIPE_FIXED);
      }
    }
  }

  // Pass 4: write — identical to the original single-pass loop, just now
  // operating on entries whose fees were already fully resolved above.
  for (const { reg, trainer, derived } of entries) {
    if (writesThisRun >= MAX_WRITES_PER_RUN) break;

    try {
      const fingerprint = deriveRowFingerprint(derived);
      const existing = log.get(reg.id);
      if (existing) {
        if (existing.status === fingerprint) continue; // already synced, unchanged
        await writeTrainerRow(spreadsheetId, trainer, existing.row, derived);
        existing.status = fingerprint;
        await appendValues(spreadsheetId, `${a1Quote(SYNC_LOG_TAB)}!A:D`, [
          [reg.id, trainer, existing.row, fingerprint],
        ]);
        result.sessionsUpdated++;
      } else {
        const row = Math.max(nextRow.get(trainer) ?? TRAINER_FIRST_ROW - 1, TRAINER_FIRST_ROW - 1) + 1;
        await copyRow(
          spreadsheetId,
          await sheetIdFor(spreadsheetId, trainer),
          TRAINER_FIRST_ROW,
          row,
          TRAINER_NUM_COLS
        );
        await writeTrainerRow(spreadsheetId, trainer, row, derived);
        nextRow.set(trainer, row);
        log.set(reg.id, { key: reg.id, tab: trainer, row, status: fingerprint });
        await appendValues(spreadsheetId, `${a1Quote(SYNC_LOG_TAB)}!A:D`, [
          [reg.id, trainer, row, fingerprint],
        ]);
        result.sessionsWritten++;
      }
      writesThisRun++;
    } catch (err) {
      result.errors.push(`registration ${reg.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Payment-method cache only ever grows (a completed transaction's method
  // never changes) — every entry here is new, always append.
  if (pmCacheWrites.size > 0) {
    await appendValues(
      spreadsheetId,
      `${a1Quote(PAYMENT_METHOD_CACHE_TAB)}!A:B`,
      Array.from(pmCacheWrites.entries()).map(([id, type]) => [id, type])
    );
  }

  // ---- package purchases -> Package Sales Log ----
  const { data: pkgSales, error: pkgErr } = await supabase
    .from("monthly_packages")
    .select("id, created_at, package_type, status, total_price, trainer_tier")
    .in("status", ["active", "cancelled"]); // both mean it was actually paid at some point
  if (pkgErr) result.errors.push(`monthly_packages query: ${pkgErr.message}`);
  result.packagesConsidered = (pkgSales || []).length;

  for (const pkg of (pkgSales || []) as MonthlyPackageRow[]) {
    if (writesThisRun >= MAX_WRITES_PER_RUN) break;
    // Only the 5 sub-trainers' packages ("other" tier) belong in this payroll
    // sheet — packages for the owner's own sessions aren't a payroll line item.
    if ((pkg.trainer_tier || "artemios") !== "other") continue;

    const key = `pkg:${pkg.id}`;
    try {
      if (log.has(key)) continue; // purchases never change after the fact — no update path needed
      const row = Math.max(nextRow.get(PSL_TAB) ?? PSL_FIRST_ROW - 1, PSL_FIRST_ROW - 1) + 1;
      await copyRow(spreadsheetId, await sheetIdFor(spreadsheetId, PSL_TAB), PSL_FIRST_ROW, row, PSL_NUM_COLS);
      const dateStr = pkg.created_at ? pkg.created_at.slice(0, 10) : "";
      const packageSize = pkg.package_type === 8 ? "8-Pack" : "4-Pack";
      // One batched request instead of one values.update per column — same
      // quota reasoning as writeTrainerRow above.
      await batchUpdateValues(spreadsheetId, [
        { range: `${a1Quote(PSL_TAB)}!A${row}`, values: [[dateStr]] },
        { range: `${a1Quote(PSL_TAB)}!B${row}`, values: [[packageSize]] },
        { range: `${a1Quote(PSL_TAB)}!D${row}`, values: [["Credit Card"]] },
        { range: `${a1Quote(PSL_TAB)}!I${row}`, values: [[`Auto-synced package purchase`]] },
      ]);
      nextRow.set(PSL_TAB, row);
      log.set(key, { key, tab: PSL_TAB, row, status: "purchased" });
      await appendValues(spreadsheetId, `${a1Quote(SYNC_LOG_TAB)}!A:D`, [[key, PSL_TAB, row, "purchased"]]);
      result.packagesWritten++;
      writesThisRun++;
    } catch (err) {
      result.errors.push(`package ${pkg.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
  } finally {
    await supabase.from("payroll_sync_lock").update({ is_running: false }).eq("id", 1);
  }
}

// Small cache so repeated lookups within one run don't re-fetch spreadsheet metadata.
const sheetIdCache = new Map<string, Map<string, number>>();
async function sheetIdFor(spreadsheetId: string, tabName: string): Promise<number> {
  let byName = sheetIdCache.get(spreadsheetId);
  if (!byName) {
    const meta = await getSheetMeta(spreadsheetId);
    byName = new Map(meta.map((s) => [s.title, s.sheetId]));
    sheetIdCache.set(spreadsheetId, byName);
  }
  const id = byName.get(tabName);
  if (id === undefined) throw new Error(`Tab "${tabName}" not found in spreadsheet`);
  return id;
}
