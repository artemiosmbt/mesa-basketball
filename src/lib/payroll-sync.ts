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
import {
  a1Quote,
  appendValues,
  batchUpdate,
  copyRow,
  getSheetMeta,
  getValues,
  updateValues,
} from "./sheets-write";

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
  status: string; // last-written cancellation flag / state, to detect no-op reruns
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
    const end = sessionEndDateTime(reg.booked_date, reg.booked_end_time);
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
  paymentType: "Credit Card" | "Credit Only" | "Package (Prepaid)";
  packageSize: "4-Pack" | "8-Pack" | "";
  discount: number;
  creditApplied: number;
  cancellationFlag: CancellationFlag;
  notes: string;
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
  };
}

/** The 10 input-column values, in A,C,D,E,F,J,K,M,O,V,X sheet order (skipping formula columns). */
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
  for (const { range, values } of rowToInputValues(r)) {
    await updateValues(spreadsheetId, `${a1Quote(tab)}!${range}${row}`, [values]);
  }
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
  const trainerSet = new Set<string>(TRAINERS);
  let writesThisRun = 0;

  // ---- sessions: registrations -> trainer tabs ----
  const { data: regs, error: regErr } = await supabase
    .from("registrations")
    .select(
      "id, parent_name, email, type, total_participants, booked_date, booked_start_time, booked_end_time, booked_trainer, status, session_price, applied_account_credit, package_id"
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

  for (const reg of registrations) {
    if (writesThisRun >= MAX_WRITES_PER_RUN) break;

    const trainer = (reg.booked_trainer || "").trim();
    if (!trainerSet.has(trainer)) {
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

    try {
      const existing = log.get(reg.id);
      if (existing) {
        if (existing.status === derived.cancellationFlag) continue; // already synced, unchanged
        await writeTrainerRow(spreadsheetId, trainer, existing.row, derived);
        existing.status = derived.cancellationFlag as string;
        await appendValues(spreadsheetId, `${a1Quote(SYNC_LOG_TAB)}!A:D`, [
          [reg.id, trainer, existing.row, derived.cancellationFlag],
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
        log.set(reg.id, { key: reg.id, tab: trainer, row, status: derived.cancellationFlag as string });
        await appendValues(spreadsheetId, `${a1Quote(SYNC_LOG_TAB)}!A:D`, [
          [reg.id, trainer, row, derived.cancellationFlag],
        ]);
        result.sessionsWritten++;
      }
      writesThisRun++;
    } catch (err) {
      result.errors.push(`registration ${reg.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      await updateValues(spreadsheetId, `${a1Quote(PSL_TAB)}!A${row}`, [[dateStr]]);
      await updateValues(spreadsheetId, `${a1Quote(PSL_TAB)}!B${row}`, [[packageSize]]);
      await updateValues(spreadsheetId, `${a1Quote(PSL_TAB)}!D${row}`, [["Credit Card"]]);
      await updateValues(spreadsheetId, `${a1Quote(PSL_TAB)}!I${row}`, [[`Auto-synced package purchase`]]);
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
