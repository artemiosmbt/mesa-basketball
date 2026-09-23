/**
 * Weekly Summary — per-week corrections that don't break the formulas.
 *
 * The problem this solves: the Weekly Summary shows one week at a time, so
 * typing a corrected number into a cell used to strip that cell's formula and
 * then show the same wrong number on every other week.
 *
 * How it works: every trainer cell keeps a formula for good. The formula asks
 * "is there a correction on file for the week showing in B4, for this trainer,
 * for this column?" — if yes it shows that number, if no it calculates the way
 * it always did. Typing over a cell files a correction; clearing the cell drops
 * it.
 *
 * Why it's built that way rather than having the script rewrite cells when the
 * week changes: a script takes several seconds to run, and for those seconds
 * the sheet would be showing last week's correction against this week's data.
 * A formula recalculates the instant B4 changes, so there is no window where a
 * wrong number is on screen. The script only runs when you type — never when
 * you just look.
 *
 * Install once:
 *   1. Extensions → Apps Script
 *   2. Paste this file over whatever is there, Save
 *   3. Run → setUpWeekOverrides   (approve the permission prompt)
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

/** The overrides sheet, quoted for use inside a formula. Its presence in a
 * cell's formula is also how we recognise a cell we've already wrapped. */
function logRef_() {
  return "'" + OVERRIDES + "'";
}

/**
 * A cell's permanent formula: the filed correction for the week in B4 if there
 * is one, otherwise the trainer's original calculation, untouched.
 */
function wrapFormula_(original, row, col) {
  var body = original.charAt(0) === '=' ? original.substring(1) : original;
  var L = logRef_();
  return '=IFERROR(INDEX(FILTER(' + L + '!$D$2:$D,' +
    L + '!$A$2:$A=$' + WEEK_CELL.charAt(0) + '$' + WEEK_CELL.substring(1) + ',' +
    L + '!$B$2:$B=$A' + row + ',' +
    L + '!$C$2:$C=' + col + '),1),' + body + ')';
}

/** Run this once. */
function setUpWeekOverrides() {
  var ss = SpreadsheetApp.getActive();
  var summary = ss.getSheetByName(SUMMARY_SHEET);
  if (!summary) throw new Error('No sheet named "' + SUMMARY_SHEET + '"');

  var rows = LAST_ROW - FIRST_ROW + 1;
  var cols = LAST_COL - FIRST_COL + 1;
  var block = summary.getRange(FIRST_ROW, FIRST_COL, rows, cols);
  var current = block.getFormulas();
  var store = ss.getSheetByName(FORMULAS);

  // Work out each cell's ORIGINAL formula — the trainer's own calculation,
  // with its own tab name and ranges. A cell already carrying the wrapper must
  // not be snapshotted as-is, or re-running this would nest the wrapper inside
  // itself; its original comes back out of the saved copy instead.
  var originals = [];
  for (var r = 0; r < rows; r++) {
    originals.push([]);
    for (var c = 0; c < cols; c++) {
      var cur = current[r][c] || '';
      if (cur && cur.indexOf(logRef_()) !== -1) {
        var saved = store ? savedAt_(store, r + 1, c + 1) : '';
        if (!saved) {
          throw new Error('Row ' + (FIRST_ROW + r) + ', column ' + (FIRST_COL + c) +
            ' is already set up but its original formula is missing from the saved copy. ' +
            'Restore the sheet from File → Version history before running this again.');
        }
        originals[r].push(saved);
      } else {
        originals[r].push(cur);
      }
    }
  }

  // Nothing above this line writes anything. If the sheet isn't in the shape
  // this expects, stop here and leave it exactly as it was found.
  var captured = 0;
  for (var r2 = 0; r2 < rows; r2++) {
    for (var c2 = 0; c2 < cols; c2++) {
      if (originals[r2][c2].charAt(0) === '=') captured++;
    }
  }
  if (captured < 10) {
    throw new Error('Only ' + captured + ' formulas found on the Weekly Summary — stopping rather than guessing. ' +
      'Check that the trainer rows still hold their formulas, then run this again.');
  }

  // Save the originals as TEXT. A string beginning with "=" written into a cell
  // becomes a live formula rather than a record of one, and a formula evaluated
  // in the wrong row breaks — that is how an earlier version of this script
  // wiped the summary. Text, always.
  if (!store) store = ss.insertSheet(FORMULAS);
  store.clear();
  store.getRange(1, 1, rows, cols).setValues(originals.map(function (row) {
    return row.map(function (f) { return f ? "'" + f : ''; });
  }));
  store.hideSheet();

  // The filed corrections. Built before the formulas, because they point at it.
  var log = ss.getSheetByName(OVERRIDES);
  if (!log) log = ss.insertSheet(OVERRIDES);
  log.clear();
  log.getRange('A1:E1').setValues([['Week', 'Trainer', 'Column', 'Value', 'Set on']]);
  log.setFrozenRows(1);
  log.hideSheet();

  // Cell by cell, never as a block: a blank string in a bulk setFormulas() call
  // clears the cell, which would wipe any cell holding a typed-in label.
  for (var r3 = 0; r3 < rows; r3++) {
    for (var c3 = 0; c3 < cols; c3++) {
      var orig = originals[r3][c3];
      if (orig.charAt(0) !== '=') continue;
      summary.getRange(FIRST_ROW + r3, FIRST_COL + c3)
        .setFormula(wrapFormula_(orig, FIRST_ROW + r3, FIRST_COL + c3));
    }
  }

  clearOldMarks_(block);
  setHighlightRule_(summary, block);

  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onWeeklySummaryEdit') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('onWeeklySummaryEdit').forSpreadsheet(ss).onEdit().create();

  SpreadsheetApp.getUi().alert(
    'Ready — ' + captured + ' formulas remembered.\n\n' +
    'Type over any number and it sticks to the week showing in B4, tinted yellow. ' +
    'Switch weeks and everything is live again, straight away. Clear a cell to drop its correction.\n\n' +
    'Any corrections filed by the earlier version have been cleared — re-enter them if you had real ones.'
  );
}

/** Only fires when someone types in a trainer cell. Nothing runs on a week change. */
function onWeeklySummaryEdit(e) {
  var range = e.range;
  var sheet = range.getSheet();
  if (sheet.getName() !== SUMMARY_SHEET) return;

  var row = range.getRow();
  var col = range.getColumn();
  if (row < FIRST_ROW || row > LAST_ROW || col < FIRST_COL || col > LAST_COL) return;
  if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return;

  var ss = sheet.getParent();
  var original = storedFormula_(ss, row, col);
  if (!original) return;   // never was a calculated cell — leave it alone

  var week = sheet.getRange(WEEK_CELL).getValue();
  var trainer = sheet.getRange(row, 1).getValue();
  var value = range.getValue();

  if (value === '' || value === null) {
    removeOverride_(ss, week, trainer, col);
  } else {
    saveOverride_(ss, week, trainer, col, value);
  }

  // Put the permanent formula back either way: the correction lives in the log
  // now, and the formula is what reads it.
  range.setFormula(wrapFormula_(original, row, col));
}

/** Matching key for the week — the raw value goes in the log so the formula can
 * compare it to B4 directly; this is only for finding an existing row. */
function weekId_(v) {
  return v instanceof Date ? 'd' + v.getTime() : 's' + String(v);
}

function saveOverride_(ss, week, trainer, col, value) {
  var log = ss.getSheetByName(OVERRIDES);
  var last = log.getLastRow();
  if (last >= 2) {
    var rows = log.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (weekId_(rows[i][0]) === weekId_(week) && rows[i][1] === trainer && String(rows[i][2]) === String(col)) {
        log.getRange(i + 2, 4, 1, 2).setValues([[value, new Date()]]);
        return;
      }
    }
  }
  log.appendRow([week, trainer, col, value, new Date()]);
}

function removeOverride_(ss, week, trainer, col) {
  var log = ss.getSheetByName(OVERRIDES);
  var last = log.getLastRow();
  if (last < 2) return;
  var rows = log.getRange(2, 1, last - 1, 3).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (weekId_(rows[i][0]) === weekId_(week) && rows[i][1] === trainer && String(rows[i][2]) === String(col)) {
      log.deleteRow(i + 2);
    }
  }
}

/** The saved original for a cell, as text. '' when there isn't a usable one, so
 * a bad snapshot can never be written into the summary. */
function storedFormula_(ss, row, col) {
  var store = ss.getSheetByName(FORMULAS);
  if (!store) return '';
  return savedAt_(store, row - FIRST_ROW + 1, col - FIRST_COL + 1);
}

function savedAt_(store, r, c) {
  var text = String(store.getRange(r, c).getValue() || '');
  return text.charAt(0) === '=' ? text : '';
}

/** Yellow tint driven by the same lookup as the formula, so it follows the week
 * with no script and no delay.
 *
 * A conditional format rule is not allowed to reference another sheet — but it
 * is allowed to reference a named range, and a named range may live anywhere.
 * So the corrections log gets three names and the rule reads those. */
function setHighlightRule_(sheet, block) {
  var ss = sheet.getParent();
  var log = ss.getSheetByName(OVERRIDES);
  defineName_(ss, 'WO_Week', log.getRange('A:A'));
  defineName_(ss, 'WO_Trainer', log.getRange('B:B'));
  defineName_(ss, 'WO_Col', log.getRange('C:C'));

  var formula = '=COUNTIFS(WO_Week,$' + WEEK_CELL.charAt(0) + '$' + WEEK_CELL.substring(1) +
    ',WO_Trainer,$A' + FIRST_ROW + ',WO_Col,COLUMN())>0';

  var kept = [];
  var existing = sheet.getConditionalFormatRules();
  for (var i = 0; i < existing.length; i++) {
    var c = existing[i].getBooleanCondition();
    var vals = c ? c.getCriteriaValues() : null;
    var text = vals && vals.length ? String(vals[0]) : '';
    var isOurs = text.indexOf('WO_Week') !== -1 || text.indexOf(OVERRIDES) !== -1;
    if (!isOurs) kept.push(existing[i]);
  }
  kept.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(formula)
      .setBackground(OVERRIDE_COLOR)
      .setRanges([block])
      .build()
  );
  sheet.setConditionalFormatRules(kept);
}

/** Point a name at a range, replacing any earlier definition of that name. */
function defineName_(ss, name, range) {
  var named = ss.getNamedRanges();
  for (var i = 0; i < named.length; i++) {
    if (named[i].getName() === name) named[i].remove();
  }
  ss.setNamedRange(name, range);
}

/** Take off the fixed tints and notes the earlier version painted on. Only
 * cells it actually marked — everything else keeps its formatting. */
function clearOldMarks_(block) {
  var backgrounds = block.getBackgrounds();
  var notes = block.getNotes();
  for (var r = 0; r < backgrounds.length; r++) {
    for (var c = 0; c < backgrounds[r].length; c++) {
      var cell = null;
      if (String(backgrounds[r][c]).toLowerCase() === OVERRIDE_COLOR) {
        cell = block.getCell(r + 1, c + 1);
        cell.setBackground(null);
      }
      if (notes[r][c] && notes[r][c].indexOf('Your correction for the week of') !== -1) {
        (cell || block.getCell(r + 1, c + 1)).clearNote();
      }
    }
  }
}
