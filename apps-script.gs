/**
 * Meal Planner — Google Apps Script backend
 * ------------------------------------------
 * This connects a Google Sheet to the Meal Planner app so multiple people
 * share one dish database.
 *
 * SETUP (one time, ~5 minutes):
 *  1. Create a Google Sheet. Rename the first tab to exactly:  Dishes
 *  2. In cell A1 paste this header row (tab-separated, spreads across A1:M1):
 *     Dish Name  Category  Cuisine  Season  Is Jain  Cooking Time  Meal Weight  Protein Source  Fiber Source  Main Ingredients  Preference  Recipe URL  Notes
 *     (Optional: paste the contents of dishes-database.csv below it to pre-fill
 *      all 170 dishes — File > Import works too.)
 *  3. Extensions > Apps Script. Delete the sample code, paste THIS file, Save.
 *  4. Deploy > New deployment > type "Web app".
 *       Execute as: Me
 *       Who has access: Anyone
 *     Deploy, authorise, and copy the Web app URL.
 *  5. In script.js, set CONFIG.BACKEND_URL to that URL.
 */

const SHEET_NAME = 'Dishes';
const HEADERS = ['Dish Name', 'Category', 'Cuisine', 'Season', 'Is Jain',
  'Cooking Time', 'Meal Weight', 'Protein Source', 'Fiber Source',
  'Main Ingredients', 'Preference', 'Recipe URL', 'Notes'];

function doGet(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return jsonResponse({ dishes: [] });
  const headers = data[0];
  const dishes = data.slice(1).map(function (row) {
    const obj = {};
    headers.forEach(function (h, i) {
      obj[h] = (row[i] !== null && row[i] !== undefined) ? String(row[i]) : '';
    });
    return obj;
  }).filter(function (d) { return d['Dish Name']; });
  return jsonResponse({ dishes: dishes });
}

function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const body = JSON.parse(e.postData.contents);
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
    // Accept a single dish object or { dishes: [...] } for bulk import
    const dishes = Array.isArray(body.dishes) ? body.dishes : [body];
    const rows = dishes.map(function (dish) {
      return HEADERS.map(function (h) { return dish[h] || ''; });
    });
    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    }
    return jsonResponse({ success: true, added: rows.length });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
