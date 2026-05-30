// ============================================================
//  Meal Planner — component-based meal composer engine
// ============================================================

// ─── CONFIG ───
const CONFIG = {
    // Supabase shared database (family sync). Leave URL blank to run local-only.
    SUPABASE_URL: 'https://bfpkwtukpzqjyytwvoqb.supabase.co',
    SUPABASE_KEY: 'sb_publishable_CF-D7Bzj6B2JDwpMN4rcKw_R8VFh3q5',
    SUPABASE_TABLE: 'dishes',
    LOCAL_DB: 'dishes-database.csv',
};
const isSupabaseConfigured = () =>
    !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY && /^https?:\/\//.test(CONFIG.SUPABASE_URL));

// Low-level Supabase REST (PostgREST) helper
async function sbRequest(pathAndQuery, options) {
    options = options || {};
    const base = CONFIG.SUPABASE_URL.replace(/\/+$/, '');
    const url = base + '/rest/v1/' + pathAndQuery;
    const headers = Object.assign({
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY,
        'Content-Type': 'application/json',
    }, options.headers || {});
    return fetch(url, Object.assign({}, options, { headers }));
}
// Strip Supabase-only fields before composing/exporting
function cleanDish(row) {
    const d = Object.assign({}, row);
    delete d.id; delete d.created_at;
    return d;
}

// ─── Engine constants ───
const PREF_WEIGHT = { More: 5, Normal: 2, Less: 0.5 };
const MAX_OVERLAP = 0.75;          // no-repeat threshold (75% of a meal)
const HISTORY_DAYS = 30;           // no-repeat window
const BREAKFAST_COOLDOWN = 6;      // days before a breakfast item can repeat
const REQUIRED_COLUMNS = ['Dish Name', 'Category', 'Season', 'Is Jain', 'Meal Weight', 'Preference'];

// ─── Pure engine helpers ───
function prefWeight(d) { return PREF_WEIGHT[d.Preference] || PREF_WEIGHT.Normal; }

function weightedRandom(pool) {
    if (!pool || pool.length === 0) return null;
    const total = pool.reduce((s, d) => s + prefWeight(d), 0);
    let r = Math.random() * total;
    for (const d of pool) { r -= prefWeight(d); if (r <= 0) return d; }
    return pool[pool.length - 1];
}

// Exempt from the no-repeat rule: dal, rice (chawal), and plain Roti
function isExempt(d) {
    return d.Category === 'dal' || d.Category === 'rice' || d['Dish Name'] === 'Roti';
}
function mealSignature(meal) {
    return meal.filter(d => d && !isExempt(d)).map(d => d['Dish Name']).sort();
}
function overlapRatio(sigA, sigB) {
    if (!sigA.length || !sigB.length) return 0;
    const setB = new Set(sigB);
    const inter = sigA.filter(x => setB.has(x)).length;
    return inter / Math.max(sigA.length, sigB.length);
}
function isRepeat(meal, historySigs, maxOverlap) {
    const sig = mealSignature(meal);
    if (sig.length === 0) return false;
    return historySigs.some(h => overlapRatio(sig, h) >= maxOverlap);
}
function mealHasProtein(meal) {
    return meal.some(d => d && d['Protein Source'] && d['Protein Source'].trim().length > 0);
}

const LEFTOVER_CATEGORIES = ['dal', 'sabzi-gravy', 'sabzi-dry', 'rice', 'bread', 'breakfast', 'raita', 'salad'];

class MealPlanner {
    constructor() {
        this.components = [];
        this.leftoverRowId = 0;
        this.supabaseMode = false;   // true once dishes are loaded from Supabase
        this.currentSeason = this.getCurrentSeason();
        this.initializeEventListeners();
        this.loadComponents();
    }

    getCurrentSeason() {
        const month = new Date().getMonth() + 1;
        if (month >= 3 && month <= 5) return 'Summer';
        if (month >= 6 && month <= 9) return 'Monsoon';
        return 'Winter'; // Oct–Feb
    }

    initializeEventListeners() {
        const fileInput = document.getElementById('file-input');
        const generateBtn = document.getElementById('generate-plan');
        const addLeftover = document.getElementById('add-leftover');
        if (fileInput) fileInput.addEventListener('change', (e) => this.handleFileUpload(e));
        if (generateBtn) generateBtn.addEventListener('click', () => this.generateMealPlan());
        if (addLeftover) addLeftover.addEventListener('click', () => this.addLeftoverRow());
    }

    // ─── Leftovers UI ───
    addLeftoverRow() {
        const list = document.getElementById('leftovers-list');
        if (!list) return;
        const id = ++this.leftoverRowId;
        const row = document.createElement('div');
        row.className = 'leftover-row';
        row.dataset.id = id;
        const catOpts = LEFTOVER_CATEGORIES.map(c => `<option value="${c}">${c.replace('-', ' ')}</option>`).join('');
        row.innerHTML = `
            <select class="leftover-cat">${catOpts}</select>
            <input type="text" class="leftover-name" placeholder="what is it? (optional)" />
            <select class="leftover-qty">
                <option value="little">A little — cook less</option>
                <option value="half">Half a meal — cook less</option>
                <option value="full">Full meal — skip cooking it</option>
            </select>
            <button type="button" class="leftover-remove" aria-label="Remove">✕</button>`;
        row.querySelector('.leftover-remove').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    collectLeftovers() {
        const rows = document.querySelectorAll('#leftovers-list .leftover-row');
        const leftovers = [];
        rows.forEach(r => {
            const category = r.querySelector('.leftover-cat').value;
            const name = r.querySelector('.leftover-name').value.trim();
            const qty = r.querySelector('.leftover-qty').value;
            leftovers.push({ category, name, qty });
        });
        return leftovers;
    }

    applyLeftovers(day, leftovers) {
        if (!day || !leftovers || !leftovers.length) return;
        leftovers.forEach(lo => {
            // Apply to the first meal that has a matching category slot
            ['breakfast', 'lunch', 'dinner'].some(mealKey => {
                const meal = day[mealKey];
                if (!meal || !meal.length) return false;
                const idx = meal.findIndex(c => c && c.Category === lo.category && !c._leftover && !c._cookLess);
                if (idx === -1) return false;
                if (lo.qty === 'full') {
                    // Reuse the leftover as this component — no fresh cooking
                    const orig = meal[idx];
                    meal[idx] = {
                        'Dish Name': lo.name || ('Leftover ' + lo.category.replace('-', ' ')),
                        'Category': lo.category,
                        'Cuisine': orig.Cuisine || '',
                        'Season': 'All Year',
                        'Is Jain': orig['Is Jain'] || 'Yes',
                        'Cooking Time': '0',
                        'Meal Weight': orig['Meal Weight'] || 'Medium',
                        'Protein Source': orig['Protein Source'] || '',
                        'Fiber Source': orig['Fiber Source'] || '',
                        'Main Ingredients': '',
                        'Preference': 'Normal',
                        'Recipe URL': '',
                        'Notes': '',
                        _leftover: true,
                    };
                } else {
                    // Keep fresh dish but flag it to be cooked in a smaller batch
                    meal[idx] = Object.assign({}, meal[idx], {
                        _cookLess: true,
                        _leftoverNote: lo.name || lo.category.replace('-', ' '),
                    });
                }
                return true;
            });
        });
    }

    // ─── Meal history (no-repeat persistence) ───
    loadHistory() {
        let hist = { lunchDinner: [], breakfast: [] };
        try {
            const raw = localStorage.getItem('mealplanner_history');
            if (raw) hist = JSON.parse(raw);
        } catch (e) { /* localStorage unavailable — run without persistence */ }
        const cutoff = Date.now() - HISTORY_DAYS * 86400000;
        hist.lunchDinner = (hist.lunchDinner || []).filter(h => h.ts >= cutoff);
        hist.breakfast = (hist.breakfast || []).filter(h => h.ts >= cutoff);
        return hist;
    }
    saveHistory(hist) {
        try { localStorage.setItem('mealplanner_history', JSON.stringify(hist)); }
        catch (e) { /* ignore */ }
    }

    // ─── User dish overrides (persisted edits / deletes / adds) ───
    loadUserData() {
        try {
            const raw = localStorage.getItem('mealplanner_user_data');
            if (raw) {
                const u = JSON.parse(raw);
                return {
                    edits: u.edits || {},
                    deletes: Array.isArray(u.deletes) ? u.deletes : [],
                    adds: Array.isArray(u.adds) ? u.adds : [],
                };
            }
        } catch (e) { /* fall through */ }
        return { edits: {}, deletes: [], adds: [] };
    }
    saveUserData(u) {
        try { localStorage.setItem('mealplanner_user_data', JSON.stringify(u)); }
        catch (e) { /* ignore */ }
    }
    // Compose the effective dish list = embedded ∪ user adds, with deletes removed
    // and edits applied. Called whenever user-data changes.
    refreshComponents() {
        const u = this.loadUserData();
        const deleted = new Set(u.deletes);
        const edits = u.edits;
        const base = (typeof window !== 'undefined' && Array.isArray(window.EMBEDDED_DISHES))
            ? window.EMBEDDED_DISHES : [];
        const result = base
            .filter(d => d && d['Dish Name'] && !deleted.has(d['Dish Name']))
            .map(d => edits[d['Dish Name']] ? Object.assign({}, d, edits[d['Dish Name']]) : d);
        const seen = new Set(result.map(d => (d['Dish Name'] || '').toLowerCase()));
        u.adds.forEach(d => {
            const k = (d['Dish Name'] || '').toLowerCase();
            if (k && !seen.has(k)) { seen.add(k); result.push(d); }
        });
        this.components = result;
    }
    // ─── Supabase write helpers ───
    async seedSupabase(dishes) {
        const rows = dishes.map(cleanDish);
        // insert in chunks to stay within request limits
        for (let i = 0; i < rows.length; i += 100) {
            const chunk = rows.slice(i, i + 100);
            const res = await sbRequest(CONFIG.SUPABASE_TABLE, {
                method: 'POST', body: JSON.stringify(chunk),
            });
            if (!res.ok) throw new Error('seed failed: HTTP ' + res.status);
        }
    }

    // add / edit / delete — async, route to Supabase when in shared mode,
    // otherwise persist locally. All return a Promise.
    async addDishLocal(dish) {
        if (!dish || !dish['Dish Name']) return false;
        const key = dish['Dish Name'].toLowerCase();
        if (this.components.some(c => (c['Dish Name'] || '').toLowerCase() === key)) return false;

        if (this.supabaseMode) {
            const res = await sbRequest(CONFIG.SUPABASE_TABLE, {
                method: 'POST',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify(cleanDish(dish)),
            });
            if (!res.ok) throw new Error('Add failed: HTTP ' + res.status);
            const created = (await res.json())[0];
            this.components.push(created || dish);
            return true;
        }
        const u = this.loadUserData();
        u.adds.push(dish);
        this.saveUserData(u);
        this.refreshComponents();
        return true;
    }

    async editDishLocal(originalName, updates) {
        if (this.supabaseMode) {
            const target = this.components.find(c => c['Dish Name'] === originalName);
            if (!target || target.id == null) throw new Error('Dish not found for edit');
            const res = await sbRequest(CONFIG.SUPABASE_TABLE + '?id=eq.' + encodeURIComponent(target.id), {
                method: 'PATCH',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify(cleanDish(updates)),
            });
            if (!res.ok) throw new Error('Edit failed: HTTP ' + res.status);
            const updated = (await res.json())[0];
            Object.assign(target, updated || updates);
            return;
        }
        const u = this.loadUserData();
        const addedIdx = u.adds.findIndex(d => d['Dish Name'] === originalName);
        if (addedIdx >= 0) {
            u.adds[addedIdx] = Object.assign({}, u.adds[addedIdx], updates);
        } else {
            u.edits[originalName] = Object.assign({}, u.edits[originalName] || {}, updates);
        }
        if (updates['Dish Name'] && updates['Dish Name'] !== originalName && addedIdx < 0) {
            u.edits[updates['Dish Name']] = u.edits[originalName];
            delete u.edits[originalName];
        }
        this.saveUserData(u);
        this.refreshComponents();
    }

    async deleteDishLocal(name) {
        if (this.supabaseMode) {
            const target = this.components.find(c => c['Dish Name'] === name);
            if (!target || target.id == null) throw new Error('Dish not found for delete');
            const res = await sbRequest(CONFIG.SUPABASE_TABLE + '?id=eq.' + encodeURIComponent(target.id), {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('Delete failed: HTTP ' + res.status);
            this.components = this.components.filter(c => c.id !== target.id);
            return;
        }
        const u = this.loadUserData();
        const addedIdx = u.adds.findIndex(d => d['Dish Name'] === name);
        if (addedIdx >= 0) {
            u.adds.splice(addedIdx, 1);
        } else if (!u.deletes.includes(name)) {
            u.deletes.push(name);
        }
        if (u.edits[name]) delete u.edits[name];
        this.saveUserData(u);
        this.refreshComponents();
    }

    resetDishLocal(name) {
        const u = this.loadUserData();
        if (u.edits[name]) delete u.edits[name];
        u.deletes = u.deletes.filter(n => n !== name);
        this.saveUserData(u);
        this.refreshComponents();
    }
    clearAllUserData() {
        // In Supabase mode there is no local override layer to clear.
        if (this.supabaseMode) return;
        try { localStorage.removeItem('mealplanner_user_data'); } catch (e) {}
        this.refreshComponents();
    }

    // ─── Data loading ───
    async loadComponents() {
        const planContent = document.getElementById('plan-content');

        // 1. Shared Supabase database (family sync), if configured
        if (isSupabaseConfigured()) {
            planContent.innerHTML = `<p class="instruction">☁️ Loading the shared family database…</p>`;
            try {
                const res = await sbRequest(CONFIG.SUPABASE_TABLE + '?select=*&order=id');
                if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
                const data = await res.json();
                const dishes = data.filter(d => d['Dish Name'] && d['Category']);
                if (dishes.length > 0) {
                    this.components = dishes;       // each row carries its `id`
                    this.supabaseMode = true;
                    this.onComponentsReady('shared family database ☁️');
                    return;
                }
                // table empty — seed it from the embedded DB so the family starts populated
                if (typeof window !== 'undefined' && Array.isArray(window.EMBEDDED_DISHES) && window.EMBEDDED_DISHES.length) {
                    await this.seedSupabase(window.EMBEDDED_DISHES);
                    const res2 = await sbRequest(CONFIG.SUPABASE_TABLE + '?select=*&order=id');
                    this.components = (await res2.json()).filter(d => d['Dish Name'] && d['Category']);
                    this.supabaseMode = true;
                    this.onComponentsReady('shared family database ☁️');
                    return;
                }
            } catch (err) {
                console.warn('Supabase load failed, using built-in database:', err);
                planContent.innerHTML = `<p class="instruction">⚠️ Couldn't reach the shared database (${MealPlanner.escapeHtml(err.message)}).<br>Using the built-in dishes for now — your changes won't sync until the connection is back.</p>`;
                // fall through to embedded so the app still works
            }
        }

        // 2. Built-in embedded database (merged with your local edits) — always works
        if (typeof window !== 'undefined' && Array.isArray(window.EMBEDDED_DISHES) && window.EMBEDDED_DISHES.length) {
            this.refreshComponents();
            if (!isSupabaseConfigured()) this.onComponentsReady('built-in database');
            else document.getElementById('generate-plan').disabled = this.components.length === 0;
            return;
        }

        // 3. Bundled CSV via fetch (works when served over http)
        try {
            const res = await fetch(CONFIG.LOCAL_DB);
            if (res.ok) {
                this.parseCSVData(await res.text(), 'bundled database');
                return;
            }
        } catch (e) { /* file:// or missing — fall through */ }

        // 4. Last resort — ask for upload
        planContent.innerHTML = `
            <p class="instruction">👋 Welcome to Meal Planner.<br><br>
            Upload a <code>dishes-database.csv</code> using the field above to get started.</p>`;
    }

    handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        const planContent = document.getElementById('plan-content');
        planContent.innerHTML = `<p class="instruction">⏳ Reading ${MealPlanner.escapeHtml(file.name)}…</p>`;
        const isXlsx = file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls');
        const reader = new FileReader();
        reader.onerror = () => {
            planContent.innerHTML = `<p class="instruction">⚠️ Couldn't read that file. Please try again.</p>`;
        };
        if (isXlsx) {
            reader.onload = (e) => {
                try {
                    if (typeof XLSX === 'undefined') throw new Error('Excel reader not loaded — check your connection');
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const sheet = workbook.Sheets[workbook.SheetNames[0]];
                    this.parseCSVData(XLSX.utils.sheet_to_csv(sheet), 'uploaded file');
                } catch (err) {
                    planContent.innerHTML = `<p class="instruction">⚠️ Couldn't read the Excel file: ${MealPlanner.escapeHtml(err.message)}</p>`;
                }
            };
            reader.readAsArrayBuffer(file);
        } else {
            reader.onload = (e) => {
                try { this.parseCSVData(e.target.result, 'uploaded file'); }
                catch (err) {
                    planContent.innerHTML = `<p class="instruction">⚠️ Couldn't read that CSV: ${MealPlanner.escapeHtml(err.message)}</p>`;
                }
            };
            reader.readAsText(file);
        }
    }

    parseCSVData(csv, sourceLabel) {
        const planContent = document.getElementById('plan-content');
        if (typeof Papa === 'undefined') {
            planContent.innerHTML = `<p class="instruction">⚠️ The CSV reader didn't load (check your internet connection), but the built-in database should still work — try refreshing the page.</p>`;
            return;
        }
        Papa.parse(csv, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                try {
                    const headers = results.meta.fields || [];
                    const missing = REQUIRED_COLUMNS.filter(c => !headers.includes(c));
                    if (missing.length > 0) {
                        document.getElementById('generate-plan').disabled = true;
                        planContent.innerHTML = `
                            <p class="instruction">⚠️ This CSV is missing required columns:<br>
                            <strong>${MealPlanner.escapeHtml(missing.join(', '))}</strong><br><br>
                            Required: ${REQUIRED_COLUMNS.join(', ')}<br><br>
                            (Tip: the built-in database already works — you only need to upload a CSV for a custom one.)</p>`;
                        return;
                    }
                    const rows = results.data.filter(d => d['Dish Name'] && d['Category']);
                    if (rows.length === 0) {
                        planContent.innerHTML = `<p class="instruction">⚠️ That CSV has the right columns but no usable rows.</p>`;
                        return;
                    }
                    this.components = rows;
                    this.onComponentsReady(sourceLabel || 'CSV');
                } catch (err) {
                    planContent.innerHTML = `<p class="instruction">⚠️ Couldn't process that CSV: ${MealPlanner.escapeHtml(err.message)}</p>`;
                }
            },
            error: (err) => {
                planContent.innerHTML = `<p class="instruction">⚠️ Couldn't parse that CSV: ${MealPlanner.escapeHtml(err && err.message ? err.message : 'unknown error')}</p>`;
            }
        });
    }

    onComponentsReady(sourceLabel) {
        const planContent = document.getElementById('plan-content');
        document.getElementById('generate-plan').disabled = this.components.length === 0;
        const byCat = {};
        this.components.forEach(c => { byCat[c.Category] = (byCat[c.Category] || 0) + 1; });
        planContent.innerHTML = `
            <p class="instruction">✅ Loaded ${this.components.length} dishes from ${sourceLabel}
            (season: ${this.currentSeason}).<br>
            Pick how many days and click <strong>"Generate Meal Plan"</strong>.</p>`;
    }

    // ─── Pools ───
    buildPools(jainOnly) {
        let avail = this.components.filter(d =>
            d.Season === 'All Year' || d.Season === this.currentSeason);
        if (jainOnly) avail = avail.filter(d => (d['Is Jain'] || '').toLowerCase() === 'yes');
        const pools = {};
        avail.forEach(d => { (pools[d.Category] = pools[d.Category] || []).push(d); });
        return pools;
    }

    // ─── Meal composers ───
    composeBreakfast(pools, recentBreakfastNames) {
        let item = null;
        for (let a = 0; a < 25; a++) {
            const cand = weightedRandom(pools.breakfast || []);
            if (!cand) break;
            item = item || cand;
            if (!recentBreakfastNames.includes(cand['Dish Name'])) { item = cand; break; }
        }
        const meal = item ? [item] : [];
        const hasProtein = item && item['Protein Source'] && item['Protein Source'].trim().length > 0;
        if (!hasProtein) {
            const proteinSides = (pools['achar-chutney'] || [])
                .filter(d => d['Protein Source'] && d['Protein Source'].trim().length > 0);
            const side = weightedRandom(proteinSides);
            if (side) meal.push(side);
        } else if (Math.random() < 0.5 && (pools['achar-chutney'] || []).length) {
            meal.push(weightedRandom(pools['achar-chutney']));
        }
        return meal;
    }

    // Worst (max) overlap of a meal's signature against history
    maxOverlapAgainst(meal, historySigs) {
        const sig = mealSignature(meal);
        if (sig.length === 0 || historySigs.length === 0) return 0;
        let worst = 0;
        for (const h of historySigs) {
            const ov = overlapRatio(sig, h);
            if (ov > worst) worst = ov;
        }
        return worst;
    }

    composeLunch(pools, historySigs) {
        let best = null, bestOverlap = Infinity;
        for (let attempt = 0; attempt < 80; attempt++) {
            const used = new Set();
            const meal = [];
            const pick = (cat) => {
                const all = pools[cat] || [];
                const avail = all.filter(d => !used.has(d['Dish Name']));
                const d = weightedRandom(avail.length ? avail : all);
                if (d) used.add(d['Dish Name']);
                return d;
            };
            const dal = pick('dal'); if (dal) meal.push(dal);
            const sg = pick('sabzi-gravy'); if (sg) meal.push(sg);
            if (Math.random() < 0.7) { const sd = pick('sabzi-dry'); if (sd) meal.push(sd); }
            const rice = pick('rice'); if (rice) meal.push(rice);
            if (Math.random() < 0.6) { const br = pick('bread'); if (br) meal.push(br); }
            const salad = pick('salad'); if (salad) meal.push(salad);
            const achar = pick('achar-chutney'); if (achar) meal.push(achar);
            const ov = this.maxOverlapAgainst(meal, historySigs);
            if (ov < MAX_OVERLAP) return meal;
            if (ov < bestOverlap) { bestOverlap = ov; best = meal; }
        }
        return best; // least-overlapping fallback when pool is tight
    }

    composeDinner(pools, historySigs, lunchHeavy) {
        let best = null, bestOverlap = Infinity;
        for (let attempt = 0; attempt < 80; attempt++) {
            const used = new Set();
            const meal = [];
            const pick = (cat, filterFn) => {
                let all = pools[cat] || [];
                if (filterFn) { const f = all.filter(filterFn); if (f.length) all = f; }
                const avail = all.filter(d => !used.has(d['Dish Name']));
                const d = weightedRandom(avail.length ? avail : all);
                if (d) used.add(d['Dish Name']);
                return d;
            };
            const lightFilter = lunchHeavy ? (d => d['Meal Weight'] !== 'Heavy') : null;
            const dal = pick('dal', lightFilter); if (dal) meal.push(dal);
            const sabziCat = Math.random() < 0.5 ? 'sabzi-gravy' : 'sabzi-dry';
            const sb = pick(sabziCat, lightFilter); if (sb) meal.push(sb);
            const rice = pick('rice', lightFilter); if (rice) meal.push(rice);
            if (Math.random() < 0.6) { const br = pick('bread'); if (br) meal.push(br); }
            const salad = pick('salad'); if (salad) meal.push(salad);
            const achar = pick('achar-chutney'); if (achar) meal.push(achar);
            if ((pools.soup || []).length && Math.random() < 0.3) {
                const soup = pick('soup'); if (soup) meal.push(soup);
            }
            const ov = this.maxOverlapAgainst(meal, historySigs);
            if (ov < MAX_OVERLAP) return meal;
            if (ov < bestOverlap) { bestOverlap = ov; best = meal; }
        }
        return best;
    }

    generatePlan(days, jainOnly, leftovers) {
        const pools = this.buildPools(jainOnly);
        if (!pools.dal || !pools['sabzi-gravy'] || !pools.rice) {
            return { error: 'Not enough dishes in the database to compose meals. Add more dals, sabzis, and rice dishes.' };
        }
        const hist = this.loadHistory();
        const ldSigs = hist.lunchDinner.map(h => h.sig);
        const now = Date.now();
        const plan = [];

        // Breakfast history as relative day offsets (history entries get negative days)
        const bfHistory = hist.breakfast.map(h => ({
            day: -Math.floor((now - h.ts) / 86400000),
            name: h.name,
        }));

        for (let i = 0; i < days; i++) {
            // Only breakfasts within the cooldown window count as "recent"
            const recentBf = bfHistory
                .filter(b => i - b.day < BREAKFAST_COOLDOWN)
                .map(b => b.name);
            const breakfast = this.composeBreakfast(pools, recentBf);
            if (breakfast[0]) bfHistory.push({ day: i, name: breakfast[0]['Dish Name'] });

            const lunch = this.composeLunch(pools, ldSigs);
            if (lunch) ldSigs.push(mealSignature(lunch));

            const lunchHeavy = lunch && lunch.some(d =>
                d.Category && d.Category.indexOf('sabzi') === 0 && d['Meal Weight'] === 'Heavy');
            const dinner = this.composeDinner(pools, ldSigs, lunchHeavy);
            if (dinner) ldSigs.push(mealSignature(dinner));

            plan.push({ dayNum: i + 1, breakfast, lunch, dinner });
        }

        // Persist this plan into history BEFORE applying leftovers,
        // so leftover markers never pollute the no-repeat history
        plan.forEach(d => {
            if (d.lunch) hist.lunchDinner.push({ ts: now, sig: mealSignature(d.lunch) });
            if (d.dinner) hist.lunchDinner.push({ ts: now, sig: mealSignature(d.dinner) });
            if (d.breakfast[0]) hist.breakfast.push({ ts: now, name: d.breakfast[0]['Dish Name'] });
        });
        this.saveHistory(hist);

        // Apply leftovers to the first day only
        if (leftovers && leftovers.length && plan[0]) {
            this.applyLeftovers(plan[0], leftovers);
        }

        return { plan };
    }

    generateMealPlan() {
        if (this.components.length === 0) {
            alert('Please load a dishes database first.');
            return;
        }
        const jainOnly = document.getElementById('jain-filter').checked;
        const daysSelect = document.getElementById('plan-days');
        const days = daysSelect ? parseInt(daysSelect.value, 10) : 2;
        const leftovers = this.collectLeftovers();

        const result = this.generatePlan(days, jainOnly, leftovers);
        if (result.error) {
            document.getElementById('plan-content').innerHTML =
                `<p class="instruction">⚠️ ${result.error}</p>`;
            return;
        }
        this.displayMealPlan(result.plan);
        this.generateGroceryList(result.plan);
    }

    // ─── Display ───
    displayMealPlan(plan) {
        const planContent = document.getElementById('plan-content');
        const dayLabel = (n) => {
            if (plan.length <= 2) return n === 1 ? 'Tomorrow' : 'Day After Tomorrow';
            return `Day ${n}`;
        };
        const esc = MealPlanner.escapeHtml;

        const renderComponent = (c) => {
            const cat = (c.Category || '').replace(/-/g, ' ');
            const catClass = 'cat-' + (c.Category || 'other');
            const isJain = (c['Is Jain'] || '').toLowerCase() === 'yes';
            const weight = c['Meal Weight'] || 'Medium';

            // Leftover: reuse — no fresh cooking, no recipe link
            if (c._leftover) {
                return `
                <div class="component-row ${catClass} is-leftover">
                    <div class="component-main">
                        <span class="component-name">${esc(c['Dish Name'])}</span>
                        <span class="component-cat">${esc(cat)}</span>
                    </div>
                    <div class="component-meta">
                        <span class="leftover-badge">♻️ use leftover</span>
                    </div>
                </div>`;
            }

            const recipeLink = c['Recipe URL'] && c['Recipe URL'].trim()
                ? `<a href="${esc(c['Recipe URL'])}" target="_blank" rel="noopener" class="recipe-link">Recipe</a>`
                : `<a href="https://www.youtube.com/results?search_query=${encodeURIComponent(c['Dish Name'] + ' recipe')}" target="_blank" rel="noopener" class="recipe-link search-yt">Recipe</a>`;
            const cookLess = c._cookLess
                ? `<span class="cookless-badge">↓ cook a smaller batch — leftover ${esc(c._leftoverNote || '')}</span>`
                : '';
            return `
                <div class="component-row ${catClass}${c._cookLess ? ' is-cookless' : ''}">
                    <div class="component-main">
                        <span class="component-name">${esc(c['Dish Name'])}</span>
                        <span class="component-cat">${esc(cat)}</span>
                        ${cookLess}
                    </div>
                    <div class="component-meta">
                        <span class="weight-indicator ${weight.toLowerCase()}">${esc(weight)}</span>
                        ${isJain ? '<span class="jain-badge">Jain</span>' : ''}
                        ${recipeLink}
                    </div>
                </div>`;
        };

        const renderMeal = (title, icon, meal) => {
            if (!meal || meal.length === 0) {
                return `<div class="meal"><div class="meal-type">${icon} ${title}</div>
                    <p class="dish-details">No dishes available for this slot.</p></div>`;
            }
            const protein = mealHasProtein(meal);
            return `
                <div class="meal">
                    <div class="meal-type">${icon} ${title}
                        ${protein ? '<span class="nutrition-badge protein">✓ protein</span>' : ''}
                    </div>
                    <div class="component-list">
                        ${meal.map(renderComponent).join('')}
                    </div>
                </div>`;
        };

        let html = '';
        plan.forEach(day => {
            html += `
                <div class="day-plan">
                    <div class="day-title">${dayLabel(day.dayNum)}</div>
                    <div class="meals-grid">
                        ${renderMeal('Breakfast', '🌅', day.breakfast)}
                        ${renderMeal('Lunch', '🍛', day.lunch)}
                        ${renderMeal('Dinner', '🌙', day.dinner)}
                    </div>
                </div>`;
        });
        planContent.innerHTML = html;
    }

    // ─── Grocery list ───
    categorizeIngredient(ingredient) {
        const i = ingredient.toLowerCase();
        const categories = [
            ['Grains & Flour', ['corn flour', 'cornflour', 'wheat flour', 'gram flour', 'multi-grain flour',
                'flattened rice', 'puffed rice', 'basmati', 'rice', 'flour', 'semolina', 'bajra', 'jowar',
                'pearl millet', 'broken wheat', 'sago', 'poha', 'noodles', 'pav', 'bread', 'roti', 'baati']],
            ['Spices & Seasonings', ['garam masala', 'tikka masala', 'kadhai masala', 'chaat masala', 'sambar powder',
                'pomegranate powder', 'mustard seeds', 'soy sauce', 'cumin', 'turmeric', 'masala',
                'pepper', 'cardamom', 'saffron', 'cinnamon', 'clove', 'chili', 'tamarind', 'vinegar', 'fennel', 'ajwain', 'asafoetida']],
            ['Dairy & Milk', ['milk', 'curd', 'yogurt', 'cream', 'butter', 'ghee', 'paneer', 'khoya', 'cheese']],
            ['Lentils & Legumes', ['dal', 'lentil', 'rajma', 'chickpeas', 'chana', 'moong', 'urad', 'toor',
                'masoor', 'sprouts', 'peas', 'beans', 'papdi', 'mangodi']],
            ['Vegetables', ['mustard greens', 'bell pepper', 'green chili', 'curry leaves', 'fresh turmeric',
                'onion', 'tomato', 'potato', 'spinach', 'cauliflower', 'brinjal', 'okra', 'gourd', 'carrot',
                'capsicum', 'mushroom', 'cabbage', 'cucumber', 'ginger', 'garlic', 'beetroot',
                'coriander', 'fenugreek', 'tinda', 'corn', 'banana', 'mint', 'kair', 'kumat']],
            ['Nuts & Dry Fruits', ['cashew', 'peanut', 'coconut', 'sesame', 'almond', 'nuts', 'dried berries']],
            ['Sweeteners', ['sugar syrup', 'sugar', 'jaggery', 'honey']],
            ['Fruits', ['raw mango', 'lemon', 'pineapple', 'pomegranate', 'mango']],
            ['Others', ['pickle', 'papad', 'sev', 'farsan', 'chutney', 'oil', 'salt', 'tea']],
        ];
        for (const [category, keywords] of categories) {
            if (keywords.some(k => i.includes(k))) return category;
        }
        return 'Others';
    }

    generateGroceryList(plan) {
        const ingredients = new Set();
        plan.forEach(day => {
            [day.breakfast, day.lunch, day.dinner].forEach(meal => {
                if (!meal) return;
                meal.forEach(c => {
                    if (c && c['Main Ingredients']) {
                        c['Main Ingredients'].split(',').forEach(ing => {
                            const t = ing.trim();
                            if (t) ingredients.add(t);
                        });
                    }
                });
            });
        });

        const groceryContent = document.getElementById('grocery-content');
        if (ingredients.size === 0) {
            groceryContent.innerHTML = '<p>No ingredients found in meal plan.</p>';
            return;
        }

        const grouped = {};
        Array.from(ingredients).sort().forEach(ing => {
            const cat = this.categorizeIngredient(ing);
            (grouped[cat] = grouped[cat] || []).push(ing);
        });

        const order = ['Vegetables', 'Lentils & Legumes', 'Dairy & Milk', 'Grains & Flour',
            'Spices & Seasonings', 'Nuts & Dry Fruits', 'Fruits', 'Sweeteners', 'Others'];
        const esc = MealPlanner.escapeHtml;
        let html = '';
        order.forEach(cat => {
            if (!grouped[cat]) return;
            html += `<div class="grocery-category">
                <div class="grocery-category-title">${cat}</div>
                <div class="grocery-category-items">
                    ${grouped[cat].map(i => `<span class="grocery-item">${esc(i)}</span>`).join('')}
                </div></div>`;
        });
        groceryContent.innerHTML = html;
    }

    static escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
}

// ============================================================
//  DishChat — add individual COMPONENTS to the database
// ============================================================
class DishChat {
    constructor(planner) {
        this.planner = planner;
        this.addedDishes = [];
        this.pendingPreviewId = 0;

        this.knownIngredients = {
            // gourds & common veg
            'turai': { english: 'Ridge Gourd', category: 'vegetable' },
            'dodka': { english: 'Ridge Gourd', category: 'vegetable' },
            'lauki': { english: 'Bottle Gourd', category: 'vegetable' },
            'louki': { english: 'Bottle Gourd', category: 'vegetable' },
            'loki': { english: 'Bottle Gourd', category: 'vegetable' },
            'dudhi': { english: 'Bottle Gourd', category: 'vegetable' },
            'bhindi': { english: 'Okra', category: 'vegetable' },
            'bhendi': { english: 'Okra', category: 'vegetable' },
            'palak': { english: 'Spinach', category: 'vegetable' },
            'paneer': { english: 'Paneer', category: 'dairy' },
            'aloo': { english: 'Potato', category: 'vegetable' },
            'batata': { english: 'Potato', category: 'vegetable' },
            'gobi': { english: 'Cauliflower', category: 'vegetable' },
            'gobhi': { english: 'Cauliflower', category: 'vegetable' },
            'matar': { english: 'Green Peas', category: 'vegetable' },
            'mutter': { english: 'Green Peas', category: 'vegetable' },
            'methi': { english: 'Fenugreek Leaves', category: 'vegetable' },
            'baingan': { english: 'Brinjal', category: 'vegetable' },
            'vangi': { english: 'Brinjal', category: 'vegetable' },
            'tamatar': { english: 'Tomato', category: 'vegetable' },
            'pyaaz': { english: 'Onion', category: 'vegetable' },
            'kakdi': { english: 'Cucumber', category: 'vegetable' },
            'kheera': { english: 'Cucumber', category: 'vegetable' },
            'kaddu': { english: 'Pumpkin', category: 'vegetable' },
            'bhopla': { english: 'Pumpkin', category: 'vegetable' },
            'tendli': { english: 'Ivy Gourd', category: 'vegetable' },
            'tindora': { english: 'Ivy Gourd', category: 'vegetable' },
            'tinda': { english: 'Apple Gourd', category: 'vegetable' },
            'parwal': { english: 'Pointed Gourd', category: 'vegetable' },
            'arbi': { english: 'Colocasia', category: 'vegetable' },
            'suran': { english: 'Yam', category: 'vegetable' },
            'shevga': { english: 'Drumstick', category: 'vegetable' },
            'drumstick': { english: 'Drumstick', category: 'vegetable' },
            'gawar': { english: 'Cluster Beans', category: 'vegetable' },
            'guar': { english: 'Cluster Beans', category: 'vegetable' },
            'cabbage': { english: 'Cabbage', category: 'vegetable' },
            'kobi': { english: 'Cabbage', category: 'vegetable' },
            'beetroot': { english: 'Beetroot', category: 'vegetable' },
            'chukandar': { english: 'Beetroot', category: 'vegetable' },
            'capsicum': { english: 'Bell Pepper', category: 'vegetable' },
            'shimla': { english: 'Bell Pepper', category: 'vegetable' },
            'carrot': { english: 'Carrot', category: 'vegetable' },
            'gajar': { english: 'Carrot', category: 'vegetable' },
            'mushroom': { english: 'Mushroom', category: 'vegetable' },
            'sarson': { english: 'Mustard Greens', category: 'vegetable' },
            'sprouts': { english: 'Mixed Sprouts', category: 'lentil' },
            // pulses & lentils
            'mangodi': { english: 'Moong Dal', category: 'lentil' },
            'mogar': { english: 'Moong Dal', category: 'lentil' },
            'moong': { english: 'Moong Dal', category: 'lentil' },
            'chana': { english: 'Chickpeas', category: 'lentil' },
            'chane': { english: 'Chickpeas', category: 'lentil' },
            'arhar': { english: 'Toor Dal', category: 'lentil' },
            'toor': { english: 'Toor Dal', category: 'lentil' },
            'tuvar': { english: 'Toor Dal', category: 'lentil' },
            'masoor': { english: 'Red Lentils', category: 'lentil' },
            'rajma': { english: 'Kidney Beans', category: 'lentil' },
            'urad': { english: 'Black Gram', category: 'lentil' },
            'matki': { english: 'Moth Beans', category: 'lentil' },
            'val': { english: 'Field Beans', category: 'lentil' },
            'chawli': { english: 'Black-Eyed Peas', category: 'lentil' },
            'lobia': { english: 'Black-Eyed Peas', category: 'lentil' },
            'vatana': { english: 'White Peas', category: 'lentil' },
            'soybean': { english: 'Soya Chunks', category: 'lentil' },
            'soyabean': { english: 'Soya Chunks', category: 'lentil' },
            'soya': { english: 'Soya Chunks', category: 'lentil' },
            // flours & grains
            'gatte': { english: 'Gram Flour', category: 'flour' },
            'gatta': { english: 'Gram Flour', category: 'flour' },
            'besan': { english: 'Gram Flour', category: 'flour' },
            'atta': { english: 'Wheat Flour', category: 'flour' },
            'chawal': { english: 'Rice', category: 'grain' },
            'makki': { english: 'Corn Flour', category: 'flour' },
            'bajra': { english: 'Pearl Millet', category: 'flour' },
            'jowar': { english: 'Jowar Flour', category: 'flour' },
            // aromatics (drive Jain detection)
            'jeera': { english: 'Cumin', category: 'spice' },
            'onion': { english: 'Onion', category: 'vegetable' },
            'garlic': { english: 'Garlic', category: 'vegetable' },
            'lahsun': { english: 'Garlic', category: 'vegetable' },
            'ginger': { english: 'Ginger', category: 'vegetable' },
            'adrak': { english: 'Ginger', category: 'vegetable' },
        };

        // keyword → component category + default weight + protein hint + cuisine hint
        // Order matters: more specific keywords should come before generic ones.
        this.dishTypes = {
            // dals & legume mains
            'daal': { category: 'dal', weight: 'Medium', protein: true },
            'dal': { category: 'dal', weight: 'Medium', protein: true },
            'pakwaan': { category: 'dal', weight: 'Heavy', protein: true },
            'pakwan': { category: 'dal', weight: 'Heavy', protein: true },
            'kadhi': { category: 'dal', weight: 'Light', protein: true },
            'sambar': { category: 'dal', weight: 'Medium', protein: true },
            'sambhar': { category: 'dal', weight: 'Medium', protein: true },
            'rajma': { category: 'dal', weight: 'Heavy', protein: true },
            'chole': { category: 'dal', weight: 'Medium', protein: true },
            'dhokli': { category: 'dal', weight: 'Heavy', protein: true },
            'usal': { category: 'sabzi-gravy', weight: 'Medium', protein: true, cuisine: 'Marathi' },
            'amti': { category: 'dal', weight: 'Medium', protein: true, cuisine: 'Marathi' },
            // sabzis
            'kofta': { category: 'sabzi-gravy', weight: 'Heavy', protein: true },
            'kofte': { category: 'sabzi-gravy', weight: 'Heavy', protein: true },
            'manchurian': { category: 'sabzi-gravy', weight: 'Medium', protein: false },
            'gatte': { category: 'sabzi-gravy', weight: 'Medium', protein: true, cuisine: 'Rajasthani' },
            'gatta': { category: 'sabzi-gravy', weight: 'Medium', protein: true, cuisine: 'Rajasthani' },
            'saag': { category: 'sabzi-gravy', weight: 'Medium', protein: false },
            'bharta': { category: 'sabzi-dry', weight: 'Light', protein: false },
            'bharti': { category: 'sabzi-dry', weight: 'Light', protein: false },
            'bhaji': { category: 'sabzi-dry', weight: 'Light', protein: false, cuisine: 'Marathi' },
            'bhaaji': { category: 'sabzi-dry', weight: 'Light', protein: false, cuisine: 'Marathi' },
            'sabzi': { category: 'sabzi-dry', weight: 'Light', protein: false },
            'sabji': { category: 'sabzi-dry', weight: 'Light', protein: false },
            'curry': { category: 'sabzi-gravy', weight: 'Medium', protein: false },
            'masala': { category: 'sabzi-gravy', weight: 'Medium', protein: false },
            'tikka': { category: 'sabzi-dry', weight: 'Medium', protein: true },
            // breads
            'roti': { category: 'bread', weight: 'Light', protein: false },
            'naan': { category: 'bread', weight: 'Medium', protein: false },
            'bhakri': { category: 'bread', weight: 'Medium', protein: false, cuisine: 'Marathi' },
            'baati': { category: 'bread', weight: 'Heavy', protein: false, cuisine: 'Rajasthani' },
            'bati': { category: 'bread', weight: 'Heavy', protein: false, cuisine: 'Rajasthani' },
            'puri': { category: 'bread', weight: 'Medium', protein: false },
            'kachori': { category: 'breakfast', weight: 'Medium', protein: false },
            // rice
            'pulao': { category: 'rice', weight: 'Medium', protein: false },
            'pulav': { category: 'rice', weight: 'Medium', protein: false },
            'biryani': { category: 'rice', weight: 'Heavy', protein: false },
            'rice': { category: 'rice', weight: 'Medium', protein: false },
            'chawal': { category: 'rice', weight: 'Medium', protein: false },
            'bhaat': { category: 'rice', weight: 'Medium', protein: false, cuisine: 'Marathi' },
            'khichdi': { category: 'rice', weight: 'Light', protein: true },
            // breakfast
            'paratha': { category: 'breakfast', weight: 'Medium', protein: false },
            'parathe': { category: 'breakfast', weight: 'Medium', protein: false },
            'thepla': { category: 'breakfast', weight: 'Light', protein: false, cuisine: 'Gujarati' },
            'thalipeeth': { category: 'breakfast', weight: 'Medium', protein: false, cuisine: 'Marathi' },
            'chilla': { category: 'breakfast', weight: 'Light', protein: true },
            'cheela': { category: 'breakfast', weight: 'Light', protein: true },
            'poha': { category: 'breakfast', weight: 'Light', protein: false, cuisine: 'Marathi' },
            'upma': { category: 'breakfast', weight: 'Medium', protein: false },
            'idli': { category: 'breakfast', weight: 'Light', protein: true, cuisine: 'South Indian' },
            'dosa': { category: 'breakfast', weight: 'Medium', protein: true, cuisine: 'South Indian' },
            'uttapam': { category: 'breakfast', weight: 'Medium', protein: true, cuisine: 'South Indian' },
            'dhokla': { category: 'breakfast', weight: 'Light', protein: true, cuisine: 'Gujarati' },
            'khaman': { category: 'breakfast', weight: 'Light', protein: true, cuisine: 'Gujarati' },
            'khandvi': { category: 'breakfast', weight: 'Light', protein: true, cuisine: 'Gujarati' },
            'khakra': { category: 'breakfast', weight: 'Light', protein: false, cuisine: 'Gujarati' },
            'handvo': { category: 'breakfast', weight: 'Medium', protein: false, cuisine: 'Gujarati' },
            'bhurji': { category: 'breakfast', weight: 'Medium', protein: true },
            'pakora': { category: 'breakfast', weight: 'Light', protein: false },
            'pakode': { category: 'breakfast', weight: 'Light', protein: false },
            'vada': { category: 'breakfast', weight: 'Medium', protein: true },
            'wada': { category: 'breakfast', weight: 'Medium', protein: true },
            'misal': { category: 'breakfast', weight: 'Heavy', protein: true, cuisine: 'Marathi' },
            'sandwich': { category: 'breakfast', weight: 'Light', protein: false },
            // sides
            'raita': { category: 'raita', weight: 'Light', protein: true },
            'salad': { category: 'salad', weight: 'Light', protein: false },
            'koshimbir': { category: 'salad', weight: 'Light', protein: false, cuisine: 'Marathi' },
            'soup': { category: 'soup', weight: 'Light', protein: false },
            'rasam': { category: 'soup', weight: 'Light', protein: false, cuisine: 'South Indian' },
            'chutney': { category: 'achar-chutney', weight: 'Light', protein: false },
            'achar': { category: 'achar-chutney', weight: 'Light', protein: false },
            'pickle': { category: 'achar-chutney', weight: 'Light', protein: false },
            'papad': { category: 'achar-chutney', weight: 'Light', protein: false },
            'thecha': { category: 'achar-chutney', weight: 'Light', protein: false, cuisine: 'Marathi' },
            // desserts
            'halwa': { category: 'dessert', weight: 'Heavy', protein: false },
            'kheer': { category: 'dessert', weight: 'Heavy', protein: true },
            'ladoo': { category: 'dessert', weight: 'Heavy', protein: false },
            'laddu': { category: 'dessert', weight: 'Heavy', protein: false },
            'barfi': { category: 'dessert', weight: 'Heavy', protein: false },
            'burfi': { category: 'dessert', weight: 'Heavy', protein: false },
            'jalebi': { category: 'dessert', weight: 'Heavy', protein: false },
            'malpua': { category: 'dessert', weight: 'Heavy', protein: false, cuisine: 'Rajasthani' },
            'shrikhand': { category: 'dessert', weight: 'Medium', protein: true, cuisine: 'Gujarati' },
            'puranpoli': { category: 'dessert', weight: 'Heavy', protein: false, cuisine: 'Marathi' },
        };

        this.categories = ['breakfast', 'dal', 'sabzi-gravy', 'sabzi-dry', 'bread',
            'rice', 'salad', 'raita', 'achar-chutney', 'soup', 'dessert'];

        this.initListeners();
    }

    // Match a word against a dish-type key, tolerating Hindi plural/oblique forms
    // (kofta↔kofte, paratha↔parathe, gatta↔gatte, pakora↔pakode-ish)
    static typeMatches(word, key) {
        if (word === key) return true;
        if (word.length >= 4 && key.length >= 4 &&
            (word.startsWith(key) || key.startsWith(word))) return true;
        const stem = s => s.replace(/[aeiou]+$/, '').replace(/s$/, '');
        const ws = stem(word), ks = stem(key);
        return ws.length >= 3 && ws === ks;
    }

    initListeners() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
            });
        });

        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('chat-send');
        if (sendBtn) sendBtn.addEventListener('click', () => this.handleInput());
        if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.handleInput(); });
        const exportBtn = document.getElementById('export-csv');
        if (exportBtn) exportBtn.addEventListener('click', () => this.exportCSV());
    }

    handleInput() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        this.addBubble(DishChat.escapeHtml(text), 'user');
        // Split into individual dishes — supports commas, semicolons, newlines
        const names = text.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
        if (names.length === 0) return;
        this.autoAddBatch(names);
    }

    // Parse one dish name into a full component record (auto-categorised)
    parseDishInput(text) {
        const clean = text.trim();
        const lower = clean.toLowerCase();
        const words = lower.split(/\s+/);

        // detect known ingredients (substring match)
        const detectedIngredients = [];
        for (const [key, info] of Object.entries(this.knownIngredients)) {
            if (lower.includes(key)) detectedIngredients.push({ key, ...info });
        }

        // detect dish type — stem-tolerant word match, first match wins
        let matchedType = null;
        for (const [key, info] of Object.entries(this.dishTypes)) {
            if (words.some(w => DishChat.typeMatches(w, key))) { matchedType = { key, ...info }; break; }
        }

        let category = matchedType ? matchedType.category : 'sabzi-gravy';
        const weight = matchedType ? matchedType.weight : 'Medium';
        const wantsProtein = matchedType ? matchedType.protein : false;

        // gravy / dry qualifier override for sabzis
        if (category === 'sabzi-dry' || category === 'sabzi-gravy') {
            if (/\b(gravy|rassa|rasse|tari|curry)\b/.test(lower)) category = 'sabzi-gravy';
            else if (/\b(dry|sukhi|sookhi|sukha|suki)\b/.test(lower)) category = 'sabzi-dry';
        }

        const cuisine = (matchedType && matchedType.cuisine) ? matchedType.cuisine : 'North Indian';

        // Jain = no onion / garlic / ginger
        const isJain = !detectedIngredients.some(i => ['Onion', 'Garlic', 'Ginger'].includes(i.english)) ? 'Yes' : 'No';

        // ingredients (dedup) + base spices
        const ingNames = [];
        detectedIngredients.forEach(i => { if (!ingNames.includes(i.english)) ingNames.push(i.english); });
        const allIngredients = ingNames.concat(['Cumin', 'Turmeric', 'Salt']);

        // protein source
        let proteinSource = '';
        if (wantsProtein) {
            const p = detectedIngredients.find(i => i.category === 'lentil' || i.category === 'dairy');
            proteinSource = p ? p.english : '';
        }
        if (detectedIngredients.some(i => i.english === 'Paneer')) proteinSource = 'Paneer';
        if (category === 'dal' && !proteinSource) proteinSource = 'Mixed Lentils';
        if (category === 'raita' && !proteinSource) proteinSource = 'Yogurt';

        // fiber source — first detected vegetable
        let fiberSource = '';
        const veg = detectedIngredients.find(i => i.category === 'vegetable');
        if (veg) fiberSource = veg.english;

        // title-case the dish name
        const dishName = clean.split(/\s+/)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

        return {
            'Dish Name': dishName,
            'Category': category,
            'Cuisine': cuisine,
            'Season': 'All Year',
            'Is Jain': isJain,
            'Cooking Time': '30',
            'Meal Weight': weight,
            'Protein Source': proteinSource,
            'Fiber Source': fiberSource,
            'Main Ingredients': allIngredients.join(', '),
            'Preference': 'Normal',
            'Recipe URL': '',
            'Notes': '',
        };
    }

    // Auto-categorise and add a batch of dishes — no confirmation form
    async autoAddBatch(names) {
        const dishes = names.map(n => this.parseDishInput(n));

        // de-dupe against what's already in the database (case-insensitive)
        const existing = new Set(this.planner.components.map(c => (c['Dish Name'] || '').toLowerCase()));
        const fresh = [];
        const skipped = [];
        dishes.forEach(d => {
            const key = d['Dish Name'].toLowerCase();
            if (!key) return;
            if (existing.has(key)) { skipped.push(d['Dish Name']); }
            else { existing.add(key); fresh.push(d); }
        });

        if (fresh.length === 0) {
            this.addBubble(`Those are already in your database — nothing new to add.`, 'system');
            return;
        }

        // Save each dish — addDishLocal routes to Supabase (shared) or localStorage
        const saved = [];
        let failed = 0;
        for (const d of fresh) {
            try {
                const ok = await this.planner.addDishLocal(d);
                if (ok) { this.addedDishes.push(d); saved.push(d); }
            } catch (err) {
                console.error('add failed:', err);
                failed++;
            }
        }
        const genBtn = document.getElementById('generate-plan');
        if (genBtn) genBtn.disabled = this.planner.components.length === 0;
        this.updateCount();

        let note = this.planner.supabaseMode
            ? ' — saved to the shared family database ☁️ (everyone sees them)'
            : ' — saved in this browser (use Export CSV to back up)';
        if (failed) note += ` · ${failed} couldn't be saved, try again`;

        this.renderBatchSummary(saved.length ? saved : fresh, skipped, note);
    }

    // Show what got added, with an inline category dropdown to fix any mistake
    renderBatchSummary(fresh, skipped, note) {
        const esc = DishChat.escapeHtml;
        const rows = fresh.map((d, idx) => {
            const opts = this.categories.map(c =>
                `<option value="${c}"${c === d['Category'] ? ' selected' : ''}>${c.replace('-', ' ')}</option>`
            ).join('');
            return `
                <div class="summary-row">
                    <span class="summary-name">${esc(d['Dish Name'])}</span>
                    <select class="summary-cat" data-idx="${idx}">${opts}</select>
                </div>`;
        }).join('');
        const skipNote = skipped.length
            ? `<div class="summary-skip">Skipped ${skipped.length} already in your database: ${esc(skipped.join(', '))}</div>`
            : '';
        const html = `
            <div class="summary-head"><strong>Added ${fresh.length} dish${fresh.length !== 1 ? 'es' : ''}</strong>${esc(note)} ✓</div>
            <div class="summary-list">${rows}</div>
            <div class="summary-hint">Wrong category? Change the dropdown — it updates instantly.</div>
            ${skipNote}`;
        const bubble = this.addBubble(html, 'result');
        bubble.querySelectorAll('.summary-cat').forEach(sel => {
            sel.addEventListener('change', () => {
                const idx = parseInt(sel.dataset.idx, 10);
                if (!fresh[idx]) return;
                const name = fresh[idx]['Dish Name'];
                fresh[idx]['Category'] = sel.value;
                Promise.resolve(this.planner.editDishLocal(name, { 'Category': sel.value }))
                    .catch(err => console.error('category update failed:', err));
            });
        });
        document.getElementById('chat-input').focus();
    }

    addBubble(content, type) {
        const messages = document.getElementById('chat-messages');
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${type}`;
        bubble.innerHTML = content;
        messages.appendChild(bubble);
        messages.scrollTop = messages.scrollHeight;
        return bubble;
    }

    updateCount() {
        const count = this.addedDishes.length;
        document.getElementById('dish-count').textContent = `${count} dish${count !== 1 ? 'es' : ''} added`;
        document.getElementById('export-csv').disabled = count === 0;
    }

    exportCSV() {
        const fields = ['Dish Name', 'Category', 'Cuisine', 'Season', 'Is Jain', 'Cooking Time',
            'Meal Weight', 'Protein Source', 'Fiber Source', 'Main Ingredients', 'Preference', 'Recipe URL', 'Notes'];
        let csv = fields.join(',') + '\n';
        this.planner.components.forEach(row => {
            csv += fields.map(f => {
                const v = (row[f] == null ? '' : row[f]).toString();
                return (v.includes(',') || v.includes('"')) ? `"${v.replace(/"/g, '""')}"` : v;
            }).join(',') + '\n';
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'dishes-database.csv';
        a.click();
        URL.revokeObjectURL(url);
        this.addBubble('CSV exported with all dishes!', 'system');
    }

    static escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
}

// ============================================================
//  ManageView — browse / edit / delete / import / export dishes
//  All changes persisted to localStorage, merged with embedded DB
// ============================================================
class ManageView {
    constructor(planner) {
        this.planner = planner;
        this.searchText = '';
        this.filterCategory = '';
        this.editingName = null;
        this.initListeners();
        this.render();
    }

    initListeners() {
        // Re-render whenever the Manage tab is activated
        const tabBtn = document.querySelector('.tab-btn[data-tab="manage"]');
        if (tabBtn) tabBtn.addEventListener('click', () => this.render());

        const search = document.getElementById('manage-search');
        const filter = document.getElementById('manage-filter');
        if (search) search.addEventListener('input', () => { this.searchText = search.value.trim().toLowerCase(); this.render(); });
        if (filter) filter.addEventListener('change', () => { this.filterCategory = filter.value; this.render(); });

        const exportBtn = document.getElementById('manage-export');
        const importInput = document.getElementById('manage-import-input');
        const resetBtn = document.getElementById('manage-reset');
        if (exportBtn) exportBtn.addEventListener('click', () => this.exportCSV());
        if (importInput) importInput.addEventListener('change', e => this.importCSV(e));
        if (resetBtn) resetBtn.addEventListener('click', () => this.resetAll());

        const cancel = document.getElementById('edit-cancel');
        const save = document.getElementById('edit-save');
        const del = document.getElementById('edit-delete');
        const backdrop = document.getElementById('edit-backdrop');
        if (cancel) cancel.addEventListener('click', () => this.closeModal());
        if (backdrop) backdrop.addEventListener('click', () => this.closeModal());
        if (save) save.addEventListener('click', () => this.saveEdit());
        if (del) del.addEventListener('click', () => this.deleteCurrent());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.editingName) this.closeModal();
        });
    }

    static FIELD_MAP = {
        name: 'Dish Name', category: 'Category', cuisine: 'Cuisine',
        season: 'Season', isJain: 'Is Jain', weight: 'Meal Weight',
        cookingTime: 'Cooking Time', preference: 'Preference',
        proteinSource: 'Protein Source', fiberSource: 'Fiber Source',
        ingredients: 'Main Ingredients', recipeUrl: 'Recipe URL', notes: 'Notes',
    };

    render() {
        const listEl = document.getElementById('manage-list');
        if (!listEl) return;
        const esc = MealPlanner.escapeHtml;
        const all = this.planner.components || [];

        const filtered = all.filter(d => {
            if (this.filterCategory && d.Category !== this.filterCategory) return false;
            if (this.searchText && !(d['Dish Name'] || '').toLowerCase().includes(this.searchText)) return false;
            return true;
        });

        const order = ['breakfast', 'dal', 'sabzi-gravy', 'sabzi-dry', 'bread', 'rice',
            'salad', 'raita', 'achar-chutney', 'soup', 'dessert'];
        const byCat = {};
        filtered.forEach(d => { (byCat[d.Category] = byCat[d.Category] || []).push(d); });

        let html = '';
        order.forEach(cat => {
            if (!byCat[cat] || !byCat[cat].length) return;
            html += `<div class="manage-section cat-${esc(cat)}">
                <div class="manage-section-head">${esc(cat.replace('-', ' '))} <span class="manage-cat-count">${byCat[cat].length}</span></div>
                <div class="manage-section-list">`;
            byCat[cat].sort((a, b) => (a['Dish Name'] || '').localeCompare(b['Dish Name'] || '')).forEach(d => {
                const jain = (d['Is Jain'] || '').toLowerCase() === 'yes';
                const meta = [d.Cuisine, d['Meal Weight'], d.Season].filter(Boolean).join(' · ');
                html += `<div class="manage-row">
                    <div class="manage-row-main">
                        <span class="manage-row-name">${esc(d['Dish Name'])}</span>
                        <span class="manage-row-meta">${esc(meta)}${jain ? ' · 🌱' : ''}</span>
                    </div>
                    <button class="manage-edit-btn" data-name="${esc(d['Dish Name'])}">Edit</button>
                </div>`;
            });
            html += '</div></div>';
        });
        if (filtered.length === 0) html = '<p class="instruction">No dishes match.</p>';
        listEl.innerHTML = html;

        listEl.querySelectorAll('.manage-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => this.openModal(btn.dataset.name));
        });

        const countEl = document.getElementById('manage-count');
        if (countEl) countEl.textContent = `${filtered.length} of ${all.length} dishes`;
    }

    openModal(name) {
        const dish = this.planner.components.find(c => c['Dish Name'] === name);
        if (!dish) return;
        this.editingName = name;
        const modal = document.getElementById('edit-modal');
        Object.entries(ManageView.FIELD_MAP).forEach(([id, key]) => {
            const el = modal.querySelector('[data-field="' + id + '"]');
            if (el) el.value = dish[key] || '';
        });
        modal.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        const firstInput = modal.querySelector('[data-field="name"]');
        if (firstInput) firstInput.focus();
    }

    closeModal() {
        const modal = document.getElementById('edit-modal');
        if (modal) modal.classList.remove('is-open');
        document.body.style.overflow = '';
        this.editingName = null;
    }

    async saveEdit() {
        if (!this.editingName) return;
        const modal = document.getElementById('edit-modal');
        const saveBtn = document.getElementById('edit-save');
        const updates = {};
        Object.entries(ManageView.FIELD_MAP).forEach(([id, key]) => {
            const el = modal.querySelector('[data-field="' + id + '"]');
            if (el) updates[key] = el.value;
        });
        const orig = saveBtn ? saveBtn.textContent : '';
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
        try {
            await this.planner.editDishLocal(this.editingName, updates);
            this.closeModal();
            this.render();
        } catch (err) {
            alert("Couldn't save: " + err.message);
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = orig; }
        }
    }

    async deleteCurrent() {
        if (!this.editingName) return;
        const restoreNote = this.planner.supabaseMode
            ? 'This removes it from the shared family database for everyone.'
            : 'You can restore the built-in dish later via "Reset all".';
        if (!confirm('Delete "' + this.editingName + '"? ' + restoreNote)) return;
        try {
            await this.planner.deleteDishLocal(this.editingName);
            this.closeModal();
            this.render();
        } catch (err) {
            alert("Couldn't delete: " + err.message);
        }
    }

    exportCSV() {
        const fields = ['Dish Name', 'Category', 'Cuisine', 'Season', 'Is Jain', 'Cooking Time',
            'Meal Weight', 'Protein Source', 'Fiber Source', 'Main Ingredients', 'Preference', 'Recipe URL', 'Notes'];
        let csv = fields.join(',') + '\n';
        this.planner.components.forEach(row => {
            csv += fields.map(f => {
                const v = (row[f] == null ? '' : row[f]).toString();
                return (v.includes(',') || v.includes('"') || v.includes('\n')) ? '"' + v.replace(/"/g, '""') + '"' : v;
            }).join(',') + '\n';
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'dishes-database-' + new Date().toISOString().slice(0, 10) + '.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    importCSV(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            if (typeof Papa === 'undefined') { alert('CSV parser not available'); return; }
            Papa.parse(e.target.result, {
                header: true,
                skipEmptyLines: true,
                complete: async (results) => {
                    const rows = (results.data || []).filter(d => d['Dish Name'] && d['Category']);
                    if (rows.length === 0) { alert('No usable rows in that CSV (need at least Dish Name + Category columns).'); return; }
                    if (!confirm('Import ' + rows.length + ' dishes? Duplicates (by name) are skipped.')) return;
                    let added = 0, skipped = 0, failed = 0;
                    for (const d of rows) {
                        try { if (await this.planner.addDishLocal(d)) added++; else skipped++; }
                        catch (err) { failed++; }
                    }
                    alert('Imported ' + added + ' dishes'
                        + (skipped ? ' (' + skipped + ' duplicates skipped)' : '')
                        + (failed ? ' — ' + failed + ' failed to save' : '') + '.');
                    this.render();
                }
            });
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    resetAll() {
        if (this.planner.supabaseMode) {
            alert('In shared mode the dishes live in your family database. To reset, re-run the setup SQL in Supabase. (Nothing was changed.)');
            return;
        }
        if (!confirm('Reset all your edits, deletes and additions? This restores the original 170 built-in dishes. (Your meal-plan history is not affected.)')) return;
        this.planner.clearAllUserData();
        this.render();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const planner = new MealPlanner();
    new DishChat(planner);
    new ManageView(planner);
});
