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
 * Design: unlike payroll-sync.ts's incremental row-diffing (needed there
 * because it's writing into a human-maintained formula sheet), this
 * REBUILDS each month's tab from scratch on every run. Each month is small
 * (~31 day-rows), full rebuild is cheap, and it sidesteps an entire class
 * of incremental-sync bugs (a status change after the fact, a corrected
 * price, etc. just fall out of a fresh rebuild automatically). The one
 * exception is each month's per-location rent cell, which is real manual
 * input (see buildLocationSection) — rebuilds preserve whatever's already
 * there instead of stomping it back to a default.
 *
 * Trainer pay is computed here in code from the exact rate constants
 * captured live from the payroll sheet's own Settings tab (2026-08-08) —
 * see RATES below — rather than depending on that sheet's formulas, since
 * this is a fully separate document.
 */
import { createClient } from "@supabase/supabase-js";
import { calcServiceFee } from "./pricing";
import { a1Quote, batchUpdate, getSheetMeta, getValues } from "./sheets-write";

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
const STRIPE_PCT_CC = 0.029;
const STRIPE_FIXED = 0.3;

interface LocationSeed { name: string; monthlyRent: number }
const KNOWN_LOCATIONS: LocationSeed[] = [
  { name: "St. Paul's Cathedral", monthlyRent: 900 },
  { name: "Cherry Valley Sports", monthlyRent: 300 },
];

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
}

interface PackageRow {
  id: string;
  created_at: string;
  package_type: number;
  status: string;
  total_price: number | null;
  trainer_tier: string | null;
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
  trainer: string;
  isCamp: boolean;
  isGroupColumn: boolean; // Group Sessions column vs Private/Solo column
  label: string;
  grossRevenue: number;
  processingFee: number;
  stripeFee: number;
  trainerPay: number;
  location: string;
}

function deriveSession(reg: RegRow, isLateCancel: boolean): DerivedSession | null {
  let isLoggableLate = false;
  if (reg.status === "no_show") {
    // full pay/full revenue, same as Completed
  } else if (reg.status === "confirmed") {
    if (!reg.booked_date) return null;
    const end = sessionEndDateTime(reg.booked_date, reg.booked_end_time);
    if (!end || end.getTime() >= Date.now()) return null; // still upcoming
  } else if (reg.status === "cancelled") {
    if (!isLateCancel) return null; // no compensable work
    isLoggableLate = true;
  } else {
    return null;
  }
  if (!reg.booked_date || !reg.booked_start_time || !reg.booked_end_time) return null;
  if (reg.booked_date < TRACKER_START_DATE) return null;

  const hours = hoursBetween(reg.booked_start_time, reg.booked_end_time);
  const participants = reg.total_participants || 1;
  const credit = reg.applied_account_credit || 0;
  const price = reg.session_price ?? 0;
  const isPackage = !!reg.package_id;

  const stripePortion = isPackage || (credit > 0 && credit >= price) ? 0 : Math.max(price - credit, 0);
  const processingFee = stripePortion > 0 ? calcServiceFee(stripePortion) : 0;
  const stripeFee = stripePortion > 0 ? round2(stripePortion * STRIPE_PCT_CC + STRIPE_FIXED) : 0;
  const grossRevenue = isLoggableLate ? round2(price * 0.5) : price;

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
  const label = isCamp
    ? `[Camp] ${reg.booked_group || "Camp"} (${kidsLabel}) $${price.toFixed(2)}`
    : isGroupColumn
      ? `${reg.booked_group || "Group"} (${kidsLabel}) $${price.toFixed(2)}`
      : `${kidsLabel}${reg.type === "group-private" ? " (Group Private)" : ""} $${price.toFixed(2)}`;

  return {
    date: reg.booked_date,
    trainer: reg.booked_trainer || OWNER_NAME,
    isCamp,
    isGroupColumn,
    label,
    grossRevenue,
    processingFee,
    stripeFee,
    trainerPay,
    location: reg.booked_location || "",
  };
}

interface DerivedPackage {
  date: string;
  label: string;
  processingFee: number;
  stripeFee: number;
}

function derivePackage(pkg: PackageRow): DerivedPackage | null {
  const date = pkg.created_at ? pkg.created_at.slice(0, 10) : "";
  if (!date || date < TRACKER_START_DATE) return null;
  const price = pkg.total_price ?? 0;
  const processingFee = price > 0 ? calcServiceFee(price) : 0;
  const stripeFee = price > 0 ? round2(price * STRIPE_PCT_CC + STRIPE_FIXED) : 0;
  const size = pkg.package_type === 8 ? "8-Pack" : "4-Pack";
  return { date, label: `${size} — $${price.toFixed(2)}`, processingFee, stripeFee };
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

async function buildMonthTab(year: number, month1: number, sessions: DerivedSession[], packages: DerivedPackage[]): Promise<void> {
  const tabName = monthTabName(year, month1);
  const sheetId = await ensureMonthTab(tabName);
  const nDays = daysInMonth(year, month1);
  const monthPrefix = `${year}-${String(month1).padStart(2, "0")}`;

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

  let monthGross = 0, monthProcessing = 0, monthStripe = 0, monthNet = 0;
  const trainerPayByWeek = new Map<string, Map<string, number>>(); // week -> trainer -> pay
  const revenueByLocation = new Map<string, number>();

  const dayRowRequests: object[] = [];
  for (let d = 1; d <= nDays; d++) {
    const dateStr = `${monthPrefix}-${String(d).padStart(2, "0")}`;
    const dayName = new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
    const daySessions = sessionsByDate.get(dateStr) || [];

    const privateSegs: TextSegment[] = [];
    const groupSegs: TextSegment[] = [];
    const places = new Set<string>();
    let gGross = 0, gProcessing = 0, gStripe = 0;

    daySessions.forEach((s, i) => {
      const seg: TextSegment = { text: `${i + 1}. ${s.label}`, color: s.isCamp ? CAMP_COLOR : TRAINER_COLOR[s.trainer] || CAMP_COLOR };
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
      if (s.location) {
        revenueByLocation.set(s.location, round2((revenueByLocation.get(s.location) || 0) + s.grossRevenue));
      }
    });

    const gNet = round2(gGross + gProcessing - gStripe);
    monthGross += gGross; monthProcessing += gProcessing; monthStripe += gStripe; monthNet += gNet;

    const rowIndex0 = 8 + (d - 1); // header is row index 7 (row 8, 1-indexed)
    dayRowRequests.push({
      updateCells: {
        rows: [
          {
            values: [
              { userEnteredValue: { stringValue: dateStr } },
              { userEnteredValue: { stringValue: dayName } },
              privateSegs.length > 0 ? { userEnteredValue: { stringValue: richTextCellData(privateSegs).stringValue }, textFormatRuns: richTextCellData(privateSegs).textFormatRuns } : { userEnteredValue: { stringValue: "" } },
              groupSegs.length > 0 ? { userEnteredValue: { stringValue: richTextCellData(groupSegs).stringValue }, textFormatRuns: richTextCellData(groupSegs).textFormatRuns } : { userEnteredValue: { stringValue: "" } },
              { userEnteredValue: { stringValue: Array.from(places).join(" / ") } },
              { userEnteredValue: { numberValue: gGross }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
              { userEnteredValue: { numberValue: gProcessing }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
              { userEnteredValue: { numberValue: gStripe }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
              { userEnteredValue: { numberValue: gNet }, userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
            ],
          },
        ],
        fields: "userEnteredValue,userEnteredFormat,textFormatRuns",
        start: { sheetId, rowIndex: rowIndex0, columnIndex: 0 },
      },
    });
  }
  requests.push(...dayRowRequests);

  // TOTALS row
  const totalsRow0 = 8 + nDays;
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
            { userEnteredValue: { numberValue: round2(monthGross) }, userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
            { userEnteredValue: { numberValue: round2(monthProcessing) }, userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
            { userEnteredValue: { numberValue: round2(monthStripe) }, userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
            { userEnteredValue: { numberValue: round2(monthNet) }, userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
          ],
        },
      ],
      fields: "userEnteredValue,userEnteredFormat",
      start: { sheetId, rowIndex: totalsRow0, columnIndex: 0 },
    },
  });

  // TRAINER PAY BY WEEK
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
  const weeks = Array.from(trainerPayByWeek.keys()).sort();
  let monthTrainerPayTotal = 0;
  for (const wk of weeks) {
    const wkMap = trainerPayByWeek.get(wk)!;
    let weekTotal = 0;
    const values = [{ userEnteredValue: { stringValue: wk } }];
    for (const t of SUB_TRAINERS) {
      const pay = wkMap.get(t) || 0;
      weekTotal += pay;
      values.push({ userEnteredValue: { numberValue: pay } } as { userEnteredValue: { numberValue: number } } as never);
    }
    values.push({ userEnteredValue: { numberValue: round2(weekTotal) } } as never);
    monthTrainerPayTotal += weekTotal;
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

  // LOCATION BREAKDOWN
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
  let monthRentTotal = 0;
  let namedLocationRevenue = 0;
  for (const loc of KNOWN_LOCATIONS) {
    const existingRent = await readExistingRent(tabName, row0 + 1); // 1-indexed row for getValues
    const rent = existingRent ?? loc.monthlyRent;
    monthRentTotal += rent;
    const revenue = round2(revenueByLocation.get(loc.name) || 0);
    namedLocationRevenue += revenue;
    requests.push({
      updateCells: {
        rows: [{
          values: [
            { userEnteredValue: { stringValue: loc.name } },
            { userEnteredValue: { numberValue: rent } },
            { userEnteredValue: { numberValue: revenue } },
            { userEnteredValue: { numberValue: round2(revenue - rent) } },
          ],
        }],
        fields: "userEnteredValue",
        start: { sheetId, rowIndex: row0, columnIndex: 0 },
      },
    });
    row0 += 1;
  }
  const otherRevenue = round2(monthGross - namedLocationRevenue);
  requests.push({
    updateCells: {
      rows: [{
        values: [
          { userEnteredValue: { stringValue: "Other / Unlisted" } },
          { userEnteredValue: { numberValue: 0 } },
          { userEnteredValue: { numberValue: otherRevenue } },
          { userEnteredValue: { numberValue: otherRevenue } },
        ],
      }],
      fields: "userEnteredValue",
      start: { sheetId, rowIndex: row0, columnIndex: 0 },
    },
  });
  row0 += 2;

  // NET PROFIT TO MESA
  const netProfit = round2(monthNet - monthTrainerPayTotal - monthRentTotal);
  requests.push({
    updateCells: {
      rows: [{
        values: [
          { userEnteredValue: { stringValue: "NET PROFIT TO MESA THIS MONTH" }, userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } },
          { userEnteredValue: { stringValue: "" } },
          { userEnteredValue: { numberValue: netProfit }, userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } },
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

  const { data: regs, error: regErr } = await supabase
    .from("registrations")
    .select(
      "id, parent_name, email, kids, type, total_participants, booked_date, booked_start_time, booked_end_time, booked_location, booked_group, booked_trainer, status, session_price, applied_account_credit, package_id"
    )
    .in("type", ["weekly", "private", "group-private", "camp"])
    .in("status", ["confirmed", "cancelled", "no_show"])
    .gte("booked_date", TRACKER_START_DATE);
  if (regErr) throw new Error(`registrations query: ${regErr.message}`);
  const registrations = (regs || []) as RegRow[];

  const cancelledIds = registrations.filter((r) => r.status === "cancelled").map((r) => r.id);
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

  const sessions: DerivedSession[] = [];
  for (const reg of registrations) {
    const derived = deriveSession(reg, isLateCancelById.get(reg.id) ?? false);
    if (derived) sessions.push(derived);
  }

  const { data: pkgSales, error: pkgErr } = await supabase
    .from("monthly_packages")
    .select("id, created_at, package_type, status, total_price, trainer_tier")
    .in("status", ["active", "cancelled"])
    .gte("created_at", TRACKER_START_DATE);
  if (pkgErr) throw new Error(`monthly_packages query: ${pkgErr.message}`);
  const packages: DerivedPackage[] = [];
  for (const pkg of (pkgSales || []) as PackageRow[]) {
    const derived = derivePackage(pkg);
    if (derived) packages.push(derived);
  }

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
    await buildMonthTab(y, m, sessions, monthPackages);
    monthsBuilt.push(monthTabName(y, m));
    void monthSessions;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  return { monthsBuilt, sessionsConsidered: sessions.length, packagesConsidered: packages.length };
}
