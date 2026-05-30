# Meal Planner

A vegetarian meal-planning web app that **composes** balanced Indian meals from a
database of individual dishes — not pre-set complete meals.

## How it works

The app holds a database of ~170 individual dishes (`dishes-database.csv`) —
including common Mumbai-household pulses and vegetables (matki/val/chawli usal,
masoor/moong dals, tendli, turai, drumstick, arbi, parwal, methi-aloo and more)
— each tagged with a **category** (dal, sabzi-gravy, sabzi-dry, bread, rice,
breakfast, salad, raita, achar-chutney, soup, dessert), season, Jain status,
meal weight, protein source, and a **preference** level (More / Normal / Less).

The engine then *builds* each meal to a set of rules:

- **Lunch** = 1 dal + 1–2 sabzi (one gravy, optionally one dry) + rice + optional
  roti + salad + a quick achar/chutney. Dal guarantees protein; rice is always
  present so "dal-chawal" is the base.
- **Dinner** = lighter — dal + one sabzi + rice + optional roti + salad + achar,
  occasionally a soup. Balanced against lunch (heavy lunch → lighter dinner).
- **Breakfast** = one breakfast item, plus a protein side if the item lacks
  protein (e.g. khakra with sing dana chutney).

### Preference weighting
Dishes marked **More** (poha, idli, dosa, khaman, paneer dishes, dal-chawal,
kofta, gatte, raita, etc.) are picked far more often; **Less** dishes (biryani,
salan, rasam, baingan, cauliflower, mushroom) are picked rarely.

### No-repeat rule
No lunch or dinner repeats 75%+ of its component combination within 30 days.
Dal, rice (chawal), and plain roti are exempt (they're everyday staples).
Breakfast items have a 6-day cooldown. History is stored in the browser
(`localStorage`), so the rule holds even across separate plan generations.

### Leftovers
Before generating, declare any leftovers (category + name + how much). The
engine adjusts the next day's plan: a full portion is reused as-is (no fresh
cooking, shown with a ♻️ badge), a partial portion keeps the fresh dish but
flags it "cook a smaller batch" — so nothing gets over-cooked.

## Files

| File | Purpose |
|---|---|
| `index.html` | **The whole app** — fully self-contained (CSS, JS, and all 170 dishes inlined). This is the only file you need. |
| `script.js` | Source copy of the engine/UI code (for editing — `index.html` has its own inlined copy) |
| `style.css` | Source copy of the styles (same — inlined into `index.html`) |
| `database.js` | Source copy of the embedded database |
| `dishes-database.csv` | The component database as a spreadsheet (~170 dishes) |
| `apps-script.gs` | Google Apps Script backend (for the optional shared database) |
| `legacy/` | The old "complete meal" CSVs, kept for reference |

## Running it

Just **double-click `index.html`** — it opens in your browser and works
immediately. Everything (the 170-dish database, all code, all styles) is
inlined into that one file, so there's nothing to upload and no other files
needed. You can even email `index.html` to someone and it'll work for them too.

If you ever change a dish in `dishes-database.csv` and want it reflected,
re-run `build-db.js` and re-inline (or just edit via the **+ Add Dish** tab and
Export CSV).

### If the app looks out of date
Browsers cache pages. If you've opened the app before and it looks stale,
close the tab completely and re-open `index.html`, or hard-refresh with
**Cmd+Shift+R** (Mac) / **Ctrl+Shift+R** (Windows).

## Adding dishes

Use the **+ Add Dish** tab. Type any single dish ("Gatte ki sabzi", "Moong dal",
"Sing dana chutney") — the app detects its category and details, you confirm,
and it's added. Export the updated database as CSV anytime.

## Shared database (optional, not yet configured)

`CONFIG.BACKEND_URL` in `script.js` can point at a Google Apps Script web app
backed by a Google Sheet, so multiple people share one dish database. The
ready-to-deploy backend code and step-by-step setup instructions are in
`apps-script.gs`. Until that URL is set, the app runs in local mode and
auto-loads the bundled `dishes-database.csv`.
