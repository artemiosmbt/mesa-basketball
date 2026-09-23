/**
 * Weekly Summary — per-week corrections that don't break the formulas.
 *
 * The problem this solves: the Weekly Summary shows one week at a time, so
 * typing a corrected number into a cell used to strip that cell's formula and
 * then show the same wrong number on every other week.
 *
 * How it works now: type over a number as you always would. The sheet files
 * that value against the week you were looking at, and tints the cell so you
 * can see it's yours. Switch weeks and every cell goes back to being live;
 * come back to that week and your number is waiting, with a note saying when
 * you set it. Clear the cell to drop the correction and go back to the formula.
 *
 * Install once:
 *   1. Extensions → Apps Script
 *   2. Paste this file over whatever is there, Save
 *   3. Run → setUpWeekOverrides   (approve the permission prompt)
 *
 * That's it — no triggers to configure, no menus to remember.
 */

var SUMMARY_SHEET = 'Weekly Summary';
var WEEK_CELL = 'B4';          // the Monday dropdown
var FIRST_ROW = 8;             // first trainer row
var LAST_ROW = 11;             // last trainer row
var FIRST_COL = 2;             // B — Sessions Run
var LAST_COL = 12;             // L — Flags
var OVERRIDES = '_WeekOverrides';
var FORMULAS = '_WeekFormulas';
var OVERRIDE_COLOR = '#fff0c2';

/** Run this once. Remembers the live formulas and starts watching for edits. */
function setUpWeekOverrides() {
  var ss = SpreadsheetApp.getActive();
  var summary = ss.getSheetByName(SUMMARY_SHEET);
  if (!summary) throw new Error('No sheet named "' + SUMMARY_SHEET + '"');

  // Snapshot the formulas exactly as they are now — including each trainer's
  // own tab name and range — so a restored cell is byte-for-byte what it was.
  //
  // Stored as TEXT, with a leading apostrophe. Writing a string that starts
  // with "=" into a cell makes it a live formula instead of a record of one —
  // and a copied formula evaluated in the wrong row breaks (a flags formula
  // that reads the trainer's name from column A finds an empty cell and
  // returns #REF!). Reading that back and writing it into the summary is how
  // this script wiped a whole sheet the first time it ran. Text, always.
  var block = summary.getRange(FIRST_ROW, FIRST_COL, LAST_ROW - FIRST_ROW + 1, LAST_COL - FIRST_COL + 1);
  var formulas = block.getFormulas();
  var asText = formulas.map(function (row) {
    return row.map(function (f) { return f ? "'" + f : ''; });
  });

  // Sanity check before this is allowed to touch anything: the snapshot has to
  // actually contain formulas. Nothing above this line writes to the file, so
  // failing here leaves the spreadsheet exactly as it was found.
  var captured = 0;
  for (var r = 0; r < asText.length; r++) {
    for (var c = 0; c < asText[r].length; c++) {
      if (String(asText[r][c]).charAt(1) === '=') captured++;
    }
  }
  if (captured < 10) {
    throw new Error('Only ' + captured + ' formulas found on the Weekly Summary — stopping rather than guessing. ' +
      'Check that the trainer rows still hold their formulas, then run this again.');
  }

  var store = ss.getSheetByName(FORMULAS) || ss.insertSheet(FORMULAS);
  store.clear();
  store.getRange(1, 1, asText.length, asText[0].length).setValues(asText);
  store.hideSheet();

  var log = ss.getSheetByName(OVERRIDES);
  if (!log) {
    log = ss.insertSheet(OVERRIDES);
    log.getRange('A1:E1').setValues([['Week', 'Trainer', 'Column', 'Value', 'Set on']]);
    log.setFrozenRows(1);
  }
  log.hideSheet();

  // One installable trigger, replacing any earlier copy of itself.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onWeeklySummaryEdit') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('onWeeklySummaryEdit').forSpreadsheet(ss).onEdit().create();

  SpreadsheetApp.getUi().alert(
    'Ready — ' + captured + ' formulas remembered.\n\n' +
    'Type over any number on the Weekly Summary and it will stick to the week you are looking at. ' +
    'Clear the cell to go back to the formula.'
  );
}

function onWeeklySummaryEdit(e) {
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SUMMARY_SHEET) return;

  // Changing the week: rebuild every trainer row for the week now showing.
  if (e.range.getA1Notation() === WEEK_CELL) {
    applyWeek_(sheet);
    return;
  }

  var row = e.range.getRow();
  var col = e.range.getColumn();
  if (row < FIRST_ROW || row > LAST_ROW || col < FIRST_COL || col > LAST_COL) return;
  if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

  var ss = sheet.getParent();
  var week = weekKey_(sheet);
  var trainer = sheet.getRange(row, 1).getValue();
  var value = e.range.getValue();

  // A cleared cell means "forget my correction" — put the formula back.
  if (value === '' || value === null) {
    removeOverride_(ss, week, trainer, col);
    restoreFormula_(ss, sheet, row, col);
    return;
  }

  // Someone pasted a formula back in themselves — treat that as the fix and
  // stop overriding this cell.
  if (typeof value === 'string' && value.charAt(0) === '=') {
    removeOverride_(ss, week, trainer, col);
    return;
  }

  saveOverride_(ss, week, trainer, col, value);
  markOverride_(e.range, week);
}

/** Rewrite every trainer cell for whichever week is showing. */
function applyWeek_(sheet) {
  var ss = sheet.getParent();
  var week = weekKey_(sheet);
  var map = overrideMap_(ss);

  for (var row = FIRST_ROW; row <= LAST_ROW; row++) {
    var trainer = sheet.getRange(row, 1).getValue();
    for (var col = FIRST_COL; col <= LAST_COL; col++) {
      var cell = sheet.getRange(row, col);
      var key = [week, trainer, col].join('|');
      if (map.hasOwnProperty(key)) {
        cell.setValue(map[key]);
        markOverride_(cell, week);
      } else {
        var formula = storedFormula_(ss, row, col);
        // No saved formula means leave the cell exactly as it is. Writing a
        // blank or an error over a working cell is the one thing this script
        // must never do.
        if (formula) {
          cell.setFormula(formula);
          cell.setBackground(null).clearNote();
        }
      }
    }
  }
}

function weekKey_(sheet) {
  var raw = sheet.getRange(WEEK_CELL).getValue();
  if (raw instanceof Date) return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(raw);
}

function overrideMap_(ss) {
  var log = ss.getSheetByName(OVERRIDES);
  var map = {};
  if (!log || log.getLastRow() < 2) return map;
  var rows = log.getRange(2, 1, log.getLastRow() - 1, 4).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    map[[normWeek_(rows[i][0]), rows[i][1], rows[i][2]].join('|')] = rows[i][3];
  }
  return map;
}

function normWeek_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

function saveOverride_(ss, week, trainer, col, value) {
  var log = ss.getSheetByName(OVERRIDES);
  var now = new Date();
  var last = log.getLastRow();
  if (last >= 2) {
    var rows = log.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (normWeek_(rows[i][0]) === week && rows[i][1] === trainer && String(rows[i][2]) === String(col)) {
        log.getRange(i + 2, 4, 1, 2).setValues([[value, now]]);   // same cell, same week — replace it
        return;
      }
    }
  }
  log.appendRow([week, trainer, col, value, now]);
}

function removeOverride_(ss, week, trainer, col) {
  var log = ss.getSheetByName(OVERRIDES);
  var last = log.getLastRow();
  if (last < 2) return;
  var rows = log.getRange(2, 1, last - 1, 3).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (normWeek_(rows[i][0]) === week && rows[i][1] === trainer && String(rows[i][2]) === String(col)) {
      log.deleteRow(i + 2);
    }
  }
}

function restoreFormula_(ss, sheet, row, col) {
  var formula = storedFormula_(ss, row, col);
  var cell = sheet.getRange(row, col);
  if (formula) cell.setFormula(formula);
  cell.setBackground(null).clearNote();
}

/** The saved formula for a cell, as text. Returns '' when there isn't a usable
 * one — and never returns an error value, so a bad snapshot can't be written
 * into the summary. */
function storedFormula_(ss, row, col) {
  var store = ss.getSheetByName(FORMULAS);
  if (!store) return '';
  var raw = store.getRange(row - FIRST_ROW + 1, col - FIRST_COL + 1).getValue();
  var text = String(raw || '');
  if (text.charAt(0) !== '=') return '';
  return text;
}

function markOverride_(range, week) {
  range.setBackground(OVERRIDE_COLOR);
  range.setNote('Your correction for the week of ' + week + '.\nClear this cell to go back to the formula.');
}
