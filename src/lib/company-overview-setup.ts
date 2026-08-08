/**
 * ONE-TIME structural setup for the company-wide revenue/profit view inside
 * the "Mesa Basketball Training LLC - Payroll and Revenue Tracker" Google
 * Sheet — adds the tabs/columns payroll-sync.ts's owner/camp/location
 * logging needs, plus a persistent Daily Ledger and the rollup views built
 * on top of it. Meant to be run exactly once (via
 * /api/admin/setup-company-overview), not on any recurring schedule —
 * unlike payroll-sync.ts, this never touches Supabase and never logs a
 * session; it only builds sheet structure and formulas. Safe to re-run
 * (every step either no-ops or overwrites idempotently) if something needs
 * fixing, but there's no reason to run it more than once in normal use.
 *
 * See src/lib/payroll-sync.ts's OWNER_TAB/CAMP_TAB rawPriceMode comments
 * for why the owner's and camps' tabs need a raw (non-formula) L column
 * instead of reusing the 5 sub-trainer tabs' rate*hours formula there.
 */
import {
  a1Quote,
  batchUpdate,
  getSheetMeta,
  updateValues,
} from "./sheets-write";
import { TRAINERS, OWNER_TAB, CAMP_TAB } from "./payroll-sync";

const REVENUE_SUMMARY_TAB = "Revenue Summary";
const PACKAGE_SALES_LOG_TAB = "Package Sales Log";
const DAILY_LEDGER_TAB = "Daily Ledger";
const MONTHLY_ROLLUP_TAB = "Monthly Rollup";
const DAY_OF_WEEK_TAB = "Day of Week";
const LOCATION_BREAKDOWN_TAB = "Location Breakdown";

// Every tab that logs individual sessions with the trainer-tab row
// template (Date/.../Gross Revenue to Mesa/.../Net Revenue to Mesa columns)
// — the 5 real sub-trainers plus the 2 new owner/camp tabs.
const ALL_SESSION_TABS = [...TRAINERS, OWNER_TAB, CAMP_TAB];

const TRAINER_FIRST_ROW = 4; // matches payroll-sync.ts's TRAINER_FIRST_ROW
const SESSION_ROW_RANGE_END = 5000; // matches the $...$5002/5003-style ranges already used in Revenue Summary
const PSL_FIRST_ROW = 5; // matches payroll-sync.ts's PSL_FIRST_ROW
const PSL_ROW_RANGE_END = 5000;

// Daily Ledger is pre-seeded this far ahead so it never needs a code change
// or manual row-add to keep working — SUMIFS formulas on empty future dates
// just read as $0 until that date's data actually gets synced.
const LEDGER_START = "2026-08-01";
const LEDGER_DAYS = 730; // ~2 years

const HEADER_BG = { red: 0.227, green: 0.153, blue: 0.11 }; // matches the brown-800 header bars already used throughout the sheet
const HEADER_TEXT = {
  bold: true,
  foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } },
};

function dateAdd(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

function addMonths(iso: string, months: number): string {
  const [y, m] = iso.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

async function sheetIdMap(spreadsheetId: string): Promise<Map<string, number>> {
  const meta = await getSheetMeta(spreadsheetId);
  return new Map(meta.map((s) => [s.title, s.sheetId]));
}

function headerCellFormatRequest(sheetId: number, rowIndex0: number, colIndex0: number) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIndex0,
        endRowIndex: rowIndex0 + 1,
        startColumnIndex: colIndex0,
        endColumnIndex: colIndex0 + 1,
      },
      cell: {
        userEnteredFormat: {
          backgroundColorStyle: { rgbColor: HEADER_BG },
          textFormat: HEADER_TEXT,
        },
      },
      fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
    },
  };
}

// ---------------------------------------------------------------------------
// Step 1: Location column (Y) on the 5 sub-trainer tabs
// ---------------------------------------------------------------------------

async function addLocationColumnToTrainerTabs(spreadsheetId: string): Promise<void> {
  const ids = await sheetIdMap(spreadsheetId);
  const formatRequests = [];
  for (const trainer of TRAINERS) {
    await updateValues(spreadsheetId, `${a1Quote(trainer)}!Y3`, [["Location"]]);
    const sheetId = ids.get(trainer);
    if (sheetId !== undefined) formatRequests.push(headerCellFormatRequest(sheetId, 2, 24));
  }
  if (formatRequests.length > 0) await batchUpdate(spreadsheetId, formatRequests);
}

// ---------------------------------------------------------------------------
// Step 2: Duplicate a trainer tab into the Owner and Camps tabs (inherits
// Location header + every formula/format/validation from step 1's source)
// ---------------------------------------------------------------------------

async function createOwnerAndCampTabs(spreadsheetId: string): Promise<void> {
  const ids = await sheetIdMap(spreadsheetId);
  if (ids.has(OWNER_TAB) && ids.has(CAMP_TAB)) return; // already set up — safe to re-run

  const sourceTab = TRAINERS[TRAINERS.length - 1]; // "Zain Amjad" — currently empty of data rows, a clean template
  const sourceSheetId = ids.get(sourceTab);
  if (sourceSheetId === undefined) throw new Error(`Source tab "${sourceTab}" not found`);

  const requests = [];
  if (!ids.has(OWNER_TAB)) {
    requests.push({ duplicateSheet: { sourceSheetId, newSheetName: OWNER_TAB } });
  }
  if (!ids.has(CAMP_TAB)) {
    requests.push({ duplicateSheet: { sourceSheetId, newSheetName: CAMP_TAB } });
  }
  if (requests.length > 0) await batchUpdate(spreadsheetId, requests);

  await updateValues(spreadsheetId, `${a1Quote(OWNER_TAB)}!A1`, [["Artemios Gavalas — Session Log"]]);
  await updateValues(spreadsheetId, `${a1Quote(CAMP_TAB)}!A1`, [["Camps — Session Log"]]);
}

// ---------------------------------------------------------------------------
// Step 3: Fix Revenue Summary!C14 — a stray leading "=" made Sheets try to
// parse an explanatory note as a formula ("Formula parse error"). Rewriting
// it without the leading "=" makes USER_ENTERED store it as plain text.
// ---------------------------------------------------------------------------

async function fixRevenueSummaryNote(spreadsheetId: string): Promise<void> {
  await updateValues(spreadsheetId, `${a1Quote(REVENUE_SUMMARY_TAB)}!C14`, [
    ["Gross Revenue + Processing Fees Collected − Stripe Fees Paid − Trainer Compensation"],
  ]);
}

// ---------------------------------------------------------------------------
// Step 4: Daily Ledger — the persistent, ever-there historical record.
// Pre-seeded with one row per day; SUMIFS pull straight from every session
// tab (+ Package Sales Log for fee columns), so nothing here needs a code
// sync of its own — it just always reflects whatever's on the source tabs.
// ---------------------------------------------------------------------------

function sessionTabRange(tab: string, col: string): string {
  return `${a1Quote(tab)}!$${col}$${TRAINER_FIRST_ROW}:$${col}$${SESSION_ROW_RANGE_END}`;
}
function sessionTabDateRange(tab: string): string {
  return `${a1Quote(tab)}!$A$${TRAINER_FIRST_ROW}:$A$${SESSION_ROW_RANGE_END}`;
}
function pslRange(col: string): string {
  return `${a1Quote(PACKAGE_SALES_LOG_TAB)}!$${col}$${PSL_FIRST_ROW}:$${col}$${PSL_ROW_RANGE_END}`;
}
function pslDateRange(): string {
  return `${a1Quote(PACKAGE_SALES_LOG_TAB)}!$A$${PSL_FIRST_ROW}:$A$${PSL_ROW_RANGE_END}`;
}

/** Sums `col` across every session tab in `tabs`, matched to date cell `dateCell`. */
function sumAcrossSessionTabs(tabs: readonly string[], col: string, dateCell: string): string {
  return tabs
    .map((tab) => `SUMIF(${sessionTabDateRange(tab)},${dateCell},${sessionTabRange(tab, col)})`)
    .join("+");
}

async function buildDailyLedger(spreadsheetId: string): Promise<void> {
  const ids = await sheetIdMap(spreadsheetId);
  if (!ids.has(DAILY_LEDGER_TAB)) {
    await batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: DAILY_LEDGER_TAB } } }]);
  }

  const headers = [
    "Date", "Day of Week", "Gross Revenue", "Processing Fees Collected",
    "Stripe Fees Paid", "Trainer Compensation Paid", "Net Profit to Mesa",
  ];
  await updateValues(spreadsheetId, `${a1Quote(DAILY_LEDGER_TAB)}!A1`, [
    ["MESA BASKETBALL TRAINING — DAILY LEDGER"],
  ]);
  await updateValues(spreadsheetId, `${a1Quote(DAILY_LEDGER_TAB)}!A2`, [
    ["One row per day, auto-totaled from every session/package tab. Pre-seeded through " + dateAdd(LEDGER_START, LEDGER_DAYS - 1) + " — nothing to maintain here."],
  ]);
  await updateValues(spreadsheetId, `${a1Quote(DAILY_LEDGER_TAB)}!A4`, [headers]);

  const rows: unknown[][] = [];
  let date = LEDGER_START;
  for (let i = 0; i < LEDGER_DAYS; i++) {
    const row = i + 5; // first data row is 5 (A4 is the header)
    const dateCell = `$A${row}`;
    rows.push([
      date,
      `=TEXT(${dateCell},"dddd")`,
      `=${sumAcrossSessionTabs(ALL_SESSION_TABS, "R", dateCell)}`,
      `=${sumAcrossSessionTabs(ALL_SESSION_TABS, "Q", dateCell)}+SUMIF(${pslDateRange()},${dateCell},${pslRange("E")})`,
      `=${sumAcrossSessionTabs(ALL_SESSION_TABS, "S", dateCell)}+SUMIF(${pslDateRange()},${dateCell},${pslRange("G")})`,
      `=${sumAcrossSessionTabs(TRAINERS, "U", dateCell)}`,
      `=C${row}+D${row}-E${row}-F${row}`,
    ]);
    date = dateAdd(date, 1);
  }
  await updateValues(spreadsheetId, `${a1Quote(DAILY_LEDGER_TAB)}!A5`, rows);

  const sheetId = ids.get(DAILY_LEDGER_TAB) ?? (await sheetIdMap(spreadsheetId)).get(DAILY_LEDGER_TAB);
  if (sheetId !== undefined) {
    await batchUpdate(spreadsheetId, [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: headers.length },
          cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: HEADER_TEXT } },
          fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
        },
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Monthly Rollup — sums the Daily Ledger by month, so it never has
// to re-derive anything from the raw session tabs itself.
// ---------------------------------------------------------------------------

const MONTHLY_ROLLUP_MONTHS = 24;

async function buildMonthlyRollup(spreadsheetId: string): Promise<void> {
  const ids = await sheetIdMap(spreadsheetId);
  if (!ids.has(MONTHLY_ROLLUP_TAB)) {
    await batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: MONTHLY_ROLLUP_TAB } } }]);
  }

  const headers = ["Month", "Gross Revenue", "Processing Fees Collected", "Stripe Fees Paid", "Trainer Compensation Paid", "Net Profit to Mesa"];
  await updateValues(spreadsheetId, `${a1Quote(MONTHLY_ROLLUP_TAB)}!A1`, [["MESA BASKETBALL TRAINING — MONTHLY ROLLUP"]]);
  await updateValues(spreadsheetId, `${a1Quote(MONTHLY_ROLLUP_TAB)}!A2`, [["Sums the Daily Ledger tab by calendar month — nothing to enter."]]);
  await updateValues(spreadsheetId, `${a1Quote(MONTHLY_ROLLUP_TAB)}!A4`, [headers]);

  const ledgerDate = `${a1Quote(DAILY_LEDGER_TAB)}!$A$5:$A$${5 + LEDGER_DAYS - 1}`;
  const ledgerCol = (col: string) => `${a1Quote(DAILY_LEDGER_TAB)}!$${col}$5:$${col}$${5 + LEDGER_DAYS - 1}`;

  const rows: unknown[][] = [];
  let month = firstOfMonth(LEDGER_START);
  for (let i = 0; i < MONTHLY_ROLLUP_MONTHS; i++) {
    const row = i + 5;
    rows.push([
      month,
      `=SUMIFS(${ledgerCol("C")},${ledgerDate},">="&$A${row},${ledgerDate},"<"&EDATE($A${row},1))`,
      `=SUMIFS(${ledgerCol("D")},${ledgerDate},">="&$A${row},${ledgerDate},"<"&EDATE($A${row},1))`,
      `=SUMIFS(${ledgerCol("E")},${ledgerDate},">="&$A${row},${ledgerDate},"<"&EDATE($A${row},1))`,
      `=SUMIFS(${ledgerCol("F")},${ledgerDate},">="&$A${row},${ledgerDate},"<"&EDATE($A${row},1))`,
      `=B${row}+C${row}-D${row}-E${row}`,
    ]);
    month = addMonths(month, 1);
  }
  await updateValues(spreadsheetId, `${a1Quote(MONTHLY_ROLLUP_TAB)}!A5`, rows);

  const sheetId = (await sheetIdMap(spreadsheetId)).get(MONTHLY_ROLLUP_TAB);
  if (sheetId !== undefined) {
    await batchUpdate(spreadsheetId, [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: headers.length },
          cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: HEADER_TEXT } },
          fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 4, endRowIndex: 4 + MONTHLY_ROLLUP_MONTHS, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "mmmm yyyy" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Step 6: Day of Week — which days are busiest, averaged only over days
// that have actually happened (TODAY()-bounded) so pre-seeded future $0
// rows never drag the average down.
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function buildDayOfWeek(spreadsheetId: string): Promise<void> {
  const ids = await sheetIdMap(spreadsheetId);
  if (!ids.has(DAY_OF_WEEK_TAB)) {
    await batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: DAY_OF_WEEK_TAB } } }]);
  }

  const headers = ["Day", "Total Gross Revenue", "Total Net Profit", "Days Elapsed", "Avg Net Profit / Day"];
  await updateValues(spreadsheetId, `${a1Quote(DAY_OF_WEEK_TAB)}!A1`, [["MESA BASKETBALL TRAINING — REVENUE BY DAY OF WEEK"]]);
  await updateValues(spreadsheetId, `${a1Quote(DAY_OF_WEEK_TAB)}!A2`, [["Sums the Daily Ledger tab by weekday, averaged only over days that have actually happened."]]);
  await updateValues(spreadsheetId, `${a1Quote(DAY_OF_WEEK_TAB)}!A4`, [headers]);

  const ledgerDay = `${a1Quote(DAILY_LEDGER_TAB)}!$B$5:$B$${5 + LEDGER_DAYS - 1}`;
  const ledgerDate = `${a1Quote(DAILY_LEDGER_TAB)}!$A$5:$A$${5 + LEDGER_DAYS - 1}`;
  const ledgerCol = (col: string) => `${a1Quote(DAILY_LEDGER_TAB)}!$${col}$5:$${col}$${5 + LEDGER_DAYS - 1}`;

  const rows = WEEKDAYS.map((day, i) => {
    const row = i + 5;
    return [
      day,
      `=SUMIF(${ledgerDay},$A${row},${ledgerCol("C")})`,
      `=SUMIF(${ledgerDay},$A${row},${ledgerCol("G")})`,
      `=COUNTIFS(${ledgerDay},$A${row},${ledgerDate},"<="&TODAY())`,
      `=IFERROR(C${row}/D${row},0)`,
    ];
  });
  await updateValues(spreadsheetId, `${a1Quote(DAY_OF_WEEK_TAB)}!A5`, rows);

  const sheetId = (await sheetIdMap(spreadsheetId)).get(DAY_OF_WEEK_TAB);
  if (sheetId !== undefined) {
    await batchUpdate(spreadsheetId, [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: headers.length },
          cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: HEADER_TEXT } },
          fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
        },
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Step 7: Location Breakdown — revenue is automatic (summed from the Y
// column now written on every session tab); cost is a manual monthly-rent
// cell per location, since no system anywhere tracks what's paid to a
// venue. Editing the rent cell updates going forward — it isn't tracked
// month-by-month historically, matching what the owner asked for ("easily
// adjust that number" each time it changes).
// ---------------------------------------------------------------------------

interface LocationSeed { name: string; monthlyRent: number | ""; }
const KNOWN_LOCATIONS: LocationSeed[] = [
  { name: "St. Paul's Cathedral", monthlyRent: 900 },
  { name: "Cherry Valley Sports", monthlyRent: 300 },
];

async function buildLocationBreakdown(spreadsheetId: string): Promise<void> {
  const ids = await sheetIdMap(spreadsheetId);
  if (!ids.has(LOCATION_BREAKDOWN_TAB)) {
    await batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: LOCATION_BREAKDOWN_TAB } } }]);
  }

  const headers = ["Location", "Monthly Rent (edit me)", "This Month Gross Revenue", "This Month Net"];
  await updateValues(spreadsheetId, `${a1Quote(LOCATION_BREAKDOWN_TAB)}!A1`, [["MESA BASKETBALL TRAINING — LOCATION BREAKDOWN"]]);
  await updateValues(spreadsheetId, `${a1Quote(LOCATION_BREAKDOWN_TAB)}!A2`, [
    ["Revenue is automatic (from every session tab's Location column). Rent is manual — edit column B whenever it changes; it isn't tracked historically, only going forward from whenever you update it."],
  ]);
  await updateValues(spreadsheetId, `${a1Quote(LOCATION_BREAKDOWN_TAB)}!A4`, [headers]);

  const monthStart = `DATE(YEAR(TODAY()),MONTH(TODAY()),1)`;
  const monthEnd = `EOMONTH(TODAY(),0)`;

  function revenueForLocationFormula(locationCellRef: string): string {
    return ALL_SESSION_TABS
      .map((tab) => {
        const dateRange = sessionTabDateRange(tab);
        const locRange = sessionTabRange(tab, "Y");
        const revRange = sessionTabRange(tab, "R");
        return `SUMIFS(${revRange},${dateRange},">="&${monthStart},${dateRange},"<="&${monthEnd},${locRange},${locationCellRef})`;
      })
      .join("+");
  }

  const rows: unknown[][] = KNOWN_LOCATIONS.map((loc, i) => {
    const row = i + 5;
    return [loc.name, loc.monthlyRent, `=${revenueForLocationFormula(`$A${row}`)}`, `=C${row}-B${row}`];
  });

  // Catch-all row: this month's total revenue minus every named location's
  // share — so a session logged at a not-yet-listed venue is still visible
  // (as "Other / Unlisted"), never silently dropped.
  const otherRow = KNOWN_LOCATIONS.length + 5;
  const namedSum = KNOWN_LOCATIONS.map((_, i) => `C${i + 5}`).join("+");
  const ledgerDate = `${a1Quote(DAILY_LEDGER_TAB)}!$A$5:$A$${5 + LEDGER_DAYS - 1}`;
  const ledgerGross = `${a1Quote(DAILY_LEDGER_TAB)}!$C$5:$C$${5 + LEDGER_DAYS - 1}`;
  rows.push([
    "Other / Unlisted",
    0,
    `=SUMIFS(${ledgerGross},${ledgerDate},">="&${monthStart},${ledgerDate},"<="&${monthEnd})-(${namedSum})`,
    `=C${otherRow}-B${otherRow}`,
  ]);

  await updateValues(spreadsheetId, `${a1Quote(LOCATION_BREAKDOWN_TAB)}!A5`, rows);

  const sheetId = (await sheetIdMap(spreadsheetId)).get(LOCATION_BREAKDOWN_TAB);
  if (sheetId !== undefined) {
    await batchUpdate(spreadsheetId, [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: headers.length },
          cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: HEADER_BG }, textFormat: HEADER_TEXT } },
          fields: "userEnteredFormat(backgroundColorStyle,textFormat)",
        },
      },
    ]);
  }
}

// ---------------------------------------------------------------------------

export interface CompanyOverviewSetupResult {
  steps: string[];
}

export async function setupCompanyOverview(): Promise<CompanyOverviewSetupResult> {
  const spreadsheetId = process.env.PAYROLL_SHEET_ID;
  if (!spreadsheetId) throw new Error("PAYROLL_SHEET_ID not configured");

  const steps: string[] = [];

  await addLocationColumnToTrainerTabs(spreadsheetId);
  steps.push("Added Location column to the 5 sub-trainer tabs");

  await createOwnerAndCampTabs(spreadsheetId);
  steps.push("Created Artemios Gavalas and Camps tabs");

  await fixRevenueSummaryNote(spreadsheetId);
  steps.push("Fixed Revenue Summary!C14 formula-parse error");

  await buildDailyLedger(spreadsheetId);
  steps.push(`Built Daily Ledger (${LEDGER_DAYS} days from ${LEDGER_START})`);

  await buildMonthlyRollup(spreadsheetId);
  steps.push(`Built Monthly Rollup (${MONTHLY_ROLLUP_MONTHS} months)`);

  await buildDayOfWeek(spreadsheetId);
  steps.push("Built Day of Week breakdown");

  await buildLocationBreakdown(spreadsheetId);
  steps.push("Built Location Breakdown (St. Paul's $900/mo, Cherry Valley $300/mo)");

  return { steps };
}
