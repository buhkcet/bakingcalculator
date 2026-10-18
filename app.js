'use strict';

/*
 * Baking Cost Calculator — plain JavaScript, no framework, no build step.
 * All data is one JSON object saved to localStorage under a single key.
 * Costs are always derived from ingredient prices; recipes store only IDs and amounts.
 */

const STORAGE_KEY = 'bakingCalc.data';
const LAST_EXPORT_KEY = 'bakingCalc.lastExported';
const DATA_VERSION = 1;
const EXPORT_REMINDER_DAYS = 14;

const DEFAULT_SETTINGS = Object.freeze({
  labour_rate_per_hr: 20.0,
  electricity_per_kwh: 0.10,
  oven_kw: 3.0,
  default_margin_pct: 30,
});

const TABS = ['ingredients', 'recipes', 'packaging', 'calculator', 'settings'];

/* =========================================================
   Helpers
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function newId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for non-secure contexts (e.g. testing over plain http on a LAN address).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Strict parse: digits with an optional decimal point. Empty, negative or anything else → NaN. */
function parseNum(value) {
  const s = String(value ?? '').trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** Hours as a decimal ("1.5") or h:mm ("1:30"). */
function parseHours(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d+):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  return parseNum(s);
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fineMoneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
});
const qtyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const pctFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const money = (n) => (Number.isFinite(n) ? moneyFmt.format(n) : '—');
const fineMoney = (n) => (Number.isFinite(n) ? fineMoneyFmt.format(n) : '—');
const qty = (n) => (Number.isFinite(n) ? qtyFmt.format(n) : '—');
const pct = (n) => `${pctFmt.format(n)}%`;
const plural = (n, word) => `${qty(n)} ${word}${n === 1 ? '' : 's'}`;
const unitLabel = (unit) => (unit === 'g' ? 'g' : 'each');
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function options(list, selectedId) {
  return list.map((o) => `<option value="${esc(o.id)}"${o.id === selectedId ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
}

function emptyState(title, text, actionHTML = '') {
  return `<div class="card empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${actionHTML}</div>`;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* =========================================================
   Data layer
   ========================================================= */

let data = null;
let loadProblem = '';

function defaultData() {
  return {
    version: DATA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    ingredients: [],
    packaging: [],
    recipes: [],
  };
}

/** Checks the shape of a data object. Returns { ok: true } or { ok: false, error }. */
function validateData(obj) {
  const fail = (error) => ({ ok: false, error });
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isStr = (v) => typeof v === 'string';

  if (!isObj(obj)) return fail('it is not a data object');
  if (obj.version !== DATA_VERSION) {
    return fail(isNum(obj.version) && obj.version > DATA_VERSION
      ? `it was made by a newer version of the app (version ${obj.version})`
      : `it has an unsupported version (${String(obj.version)})`);
  }

  const s = obj.settings;
  if (!isObj(s)) return fail('settings are missing');
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!isNum(s[key]) || s[key] < 0) return fail(`settings.${key} must be a number of 0 or more`);
  }
  if (s.default_margin_pct >= 100) return fail('settings.default_margin_pct must be below 100');

  for (const key of ['ingredients', 'packaging', 'recipes']) {
    if (!Array.isArray(obj[key])) return fail(`${key} must be a list`);
  }

  const checkItem = (item, where, ids) => {
    if (!isObj(item)) return `${where} is not an object`;
    if (!isStr(item.id) || !item.id) return `${where}.id is missing`;
    if (ids.has(item.id)) return `${where}.id is a duplicate`;
    ids.add(item.id);
    if (!isStr(item.name) || !item.name.trim()) return `${where}.name is missing`;
    return '';
  };

  let ids = new Set();
  for (const [i, ing] of obj.ingredients.entries()) {
    const w = `ingredients[${i}]`;
    const e = checkItem(ing, w, ids);
    if (e) return fail(e);
    if (ing.unit !== 'g' && ing.unit !== 'each') return fail(`${w}.unit must be "g" or "each"`);
    if (!isNum(ing.pack_qty) || ing.pack_qty <= 0) return fail(`${w}.pack_qty must be above 0`);
    if (!isNum(ing.pack_price) || ing.pack_price < 0) return fail(`${w}.pack_price must be 0 or more`);
    if (typeof ing.deleted !== 'boolean') return fail(`${w}.deleted must be true or false`);
  }

  ids = new Set();
  for (const [i, p] of obj.packaging.entries()) {
    const w = `packaging[${i}]`;
    const e = checkItem(p, w, ids);
    if (e) return fail(e);
    if (!isStr(p.description)) return fail(`${w}.description must be text`);
    if (!isNum(p.price) || p.price < 0) return fail(`${w}.price must be 0 or more`);
    if (typeof p.deleted !== 'boolean') return fail(`${w}.deleted must be true or false`);
  }

  ids = new Set();
  for (const [i, r] of obj.recipes.entries()) {
    const w = `recipes[${i}]`;
    const e = checkItem(r, w, ids);
    if (e) return fail(e);
    if (!isNum(r.yield_units) || r.yield_units <= 0) return fail(`${w}.yield_units must be above 0`);
    if (!Array.isArray(r.ingredients)) return fail(`${w}.ingredients must be a list`);
    for (const [j, line] of r.ingredients.entries()) {
      if (!isObj(line) || !isStr(line.ingredient_id) || !line.ingredient_id) {
        return fail(`${w}.ingredients[${j}].ingredient_id is missing`);
      }
      if (!isNum(line.amount) || line.amount < 0) return fail(`${w}.ingredients[${j}].amount must be 0 or more`);
    }
  }

  return { ok: true };
}

function loadData() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    loadProblem = `This browser is blocking storage (${e.message}). Nothing you enter will be saved.`;
    return defaultData();
  }
  if (!raw) return defaultData();
  try {
    const obj = JSON.parse(raw);
    const check = validateData(obj);
    if (!check.ok) throw new Error(check.error);
    return obj;
  } catch (e) {
    // Keep the unreadable copy so nothing is lost, then start fresh.
    try { localStorage.setItem(`${STORAGE_KEY}.unreadable.${Date.now()}`, raw); } catch { /* ignore */ }
    loadProblem = `Your saved data couldn't be read (${e.message}). A copy was kept, and the app started empty. You can import your last export from Settings.`;
    return defaultData();
  }
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    alertModal('Could not save', `Your change could not be saved (${e.message}). Export your data from Settings as a backup.`);
    return false;
  }
}

function requestPersistentStorage() {
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
}

const findIngredient = (id) => data.ingredients.find((i) => i.id === id) || null;
const findPackaging = (id) => data.packaging.find((p) => p.id === id) || null;
const findRecipe = (id) => data.recipes.find((r) => r.id === id) || null;
const activeIngredients = () => data.ingredients.filter((i) => !i.deleted).sort(byName);
const activePackaging = () => data.packaging.filter((p) => !p.deleted).sort(byName);
const recipesUsing = (ingredientId) =>
  data.recipes.filter((r) => r.ingredients.some((l) => l.ingredient_id === ingredientId)).sort(byName);

/** Cost per gram or per item. Derived, never stored. */
const unitCost = (ing) => ing.pack_price / ing.pack_qty;

function unitCostLabel(ing) {
  const c = unitCost(ing);
  return ing.unit === 'g' ? `${fineMoney(c)} / g <span class="muted">(${money(c * 1000)} / kg)</span>` : `${money(c)} each`;
}

/** Ingredient cost of a recipe. Lines pointing at deleted or unknown ingredients are excluded and reported. */
function ingredientCost(recipe) {
  let total = 0;
  const missing = [];
  for (const line of recipe.ingredients) {
    const ing = findIngredient(line.ingredient_id);
    if (!ing || ing.deleted) {
      missing.push(ing ? ing.name : 'Unknown ingredient');
      continue;
    }
    total += line.amount * unitCost(ing);
  }
  return { total, missing };
}

/* ---------- Export / import ---------- */

function lastExportInfo() {
  let iso = null;
  try { iso = localStorage.getItem(LAST_EXPORT_KEY); } catch { /* ignore */ }
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return { text: 'Never', stale: true };
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  const when = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return { text: `${when} (${days <= 0 ? 'today' : `${plural(days, 'day')} ago`})`, stale: days >= EXPORT_REMINDER_DAYS };
}

function hasAnyData() {
  return data.ingredients.length > 0 || data.packaging.length > 0 || data.recipes.length > 0;
}

function markExported() {
  try { localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString()); } catch { /* ignore */ }
  render();
}

async function exportData() {
  const name = `baking-data-${todayStamp()}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });

  // On iPad the share sheet is the reliable way to "Save to Files" from a Home Screen app.
  const touch = navigator.maxTouchPoints > 0;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      markExported();
      toast('Exported');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user closed the share sheet
      // otherwise fall through to a plain download
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  markExported();
  toast(`Downloaded ${name}`);
}

async function importFile(file) {
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch {
    alertModal("Can't import", `“${file.name}” isn't a readable JSON file.`);
    return;
  }
  const check = validateData(obj);
  if (!check.ok) {
    alertModal("Can't import", `“${file.name}” isn't valid baking data: ${check.error}.`);
    return;
  }
  const count = (list, word) => plural(list.filter((x) => !x.deleted).length, word);
  const ok = await openModal({
    title: 'Replace all data?',
    body: `<p><strong>This will replace all current data</strong> with the contents of “${esc(file.name)}”:</p>
      <p>${count(obj.ingredients, 'ingredient')}, ${count(obj.packaging, 'packaging item')}, ${plural(obj.recipes.length, 'recipe')}.</p>
      <p class="hint">If you're not sure, export your current data first.</p>`,
    okLabel: 'Replace',
    danger: true,
  });
  if (!ok) return;
  data = obj;
  if (!saveData()) return;
  draft = null;
  resetCalc();
  render();
  toast('Data imported');
}

/* =========================================================
   Modal
   ========================================================= */

/**
 * Opens the shared dialog. Resolves true on OK, false on cancel.
 * onOk(form) may return an error string to keep the dialog open.
 */
function openModal({ title, body, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, onOpen, onOk }) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    dlg.innerHTML = `
      <form class="modal-card" novalidate>
        <h2>${esc(title)}</h2>
        <div class="modal-body">${body}</div>
        <p class="form-error" role="alert" hidden></p>
        <div class="modal-actions">
          ${cancelLabel ? `<button type="button" class="btn" data-modal-cancel>${esc(cancelLabel)}</button>` : ''}
          <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(okLabel)}</button>
        </div>
      </form>`;
    const form = $('form', dlg);
    const errorEl = $('.form-error', form);
    const finish = (result) => {
      dlg.close();
      resolve(result);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (onOk) {
        const problem = onOk(form);
        if (typeof problem === 'string' && problem) {
          errorEl.textContent = problem;
          errorEl.hidden = false;
          return;
        }
      }
      finish(true);
    });
    $('[data-modal-cancel]', form)?.addEventListener('click', () => finish(false));
    dlg.oncancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    if (onOpen) onOpen(form);
    dlg.showModal();
  });
}

function alertModal(title, message) {
  return openModal({ title, body: `<p>${esc(message)}</p>`, cancelLabel: null });
}

const fieldValue = (form, name) => form.elements.namedItem(name).value;

/* =========================================================
   Ingredients
   ========================================================= */

function renderIngredients(view) {
  const list = activeIngredients();
  view.innerHTML = `
    <div class="view-head">
      <h1>Ingredients</h1>
      <button class="btn btn-primary" data-action="ing-add">+ Add ingredient</button>
    </div>
    ${list.length ? `
      <div class="card table-wrap">
        <table class="list">
          <thead><tr><th>Name</th><th class="num">Pack</th><th class="num">Pack price</th><th class="num">Cost</th><th></th></tr></thead>
          <tbody>
            ${list.map((i) => `
              <tr>
                <td class="name">${esc(i.name)}</td>
                <td class="num">${qty(i.pack_qty)} ${unitLabel(i.unit)}</td>
                <td class="num">${money(i.pack_price)}</td>
                <td class="num">${unitCostLabel(i)}</td>
                <td><div class="row-actions">
                  <button class="btn btn-small" data-action="ing-edit" data-id="${esc(i.id)}">Edit</button>
                  <button class="btn btn-small btn-ghost-danger" data-action="ing-delete" data-id="${esc(i.id)}">Delete</button>
                </div></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : emptyState('No ingredients yet', 'Add the things you buy, with the pack size and the price you pay. Costs per gram or per item are worked out for you.',
      '<button class="btn btn-primary" data-action="ing-add">+ Add ingredient</button>')}`;
}

function editIngredient(id) {
  const ing = id ? findIngredient(id) : null;
  const unit = ing ? ing.unit : 'g';
  const usedIn = ing ? recipesUsing(ing.id) : [];
  openModal({
    title: ing ? 'Edit ingredient' : 'Add ingredient',
    okLabel: ing ? 'Save' : 'Add',
    body: `
      <label class="field"><span>Name</span>
        <input name="name" value="${esc(ing?.name)}" autocomplete="off" autocapitalize="words" placeholder="e.g. Plain flour"></label>
      <div class="field"><span>Measured in</span>
        <div class="seg" role="radiogroup" aria-label="Measured in">
          <label><input type="radio" name="unit" value="g"${unit === 'g' ? ' checked' : ''}><span>Grams (g)</span></label>
          <label><input type="radio" name="unit" value="each"${unit === 'each' ? ' checked' : ''}><span>Each (items)</span></label>
        </div>
      </div>
      <div class="field-row">
        <label class="field"><span>Pack quantity</span>
          <div class="amount"><input name="pack_qty" inputmode="decimal" autocomplete="off" value="${ing ? ing.pack_qty : ''}" placeholder="${unit === 'g' ? 'e.g. 1000' : 'e.g. 12'}"><span class="unit js-unit">${unitLabel(unit)}</span></div></label>
        <label class="field"><span>Pack price</span>
          <div class="amount"><span class="pre">$</span><input name="pack_price" inputmode="decimal" autocomplete="off" value="${ing ? ing.pack_price : ''}" placeholder="e.g. 4.29"></div></label>
      </div>
      ${usedIn.length ? `<p class="hint">Used in ${plural(usedIn.length, 'recipe')}. Recipe amounts are in this ingredient's unit, so switching between grams and each changes what those amounts mean.</p>` : ''}`,
    onOpen: (form) => {
      form.addEventListener('change', (e) => {
        if (e.target.name !== 'unit') return;
        $('.js-unit', form).textContent = unitLabel(e.target.value);
        form.elements.namedItem('pack_qty').placeholder = e.target.value === 'g' ? 'e.g. 1000' : 'e.g. 12';
      });
    },
    onOk: (form) => {
      const name = fieldValue(form, 'name').trim();
      const newUnit = fieldValue(form, 'unit');
      const packQty = parseNum(fieldValue(form, 'pack_qty'));
      const packPrice = parseNum(fieldValue(form, 'pack_price'));
      if (!name) return 'Enter a name.';
      if (activeIngredients().some((o) => o.id !== id && sameName(o.name, name))) {
        return `There's already an ingredient called “${name}”.`;
      }
      if (!(packQty > 0)) return 'Pack quantity must be a number above 0 (digits and a decimal point only).';
      if (!(packPrice >= 0)) return 'Pack price must be a number, e.g. 4.29.';
      if (ing) {
        Object.assign(ing, { name, unit: newUnit, pack_qty: packQty, pack_price: packPrice });
      } else {
        data.ingredients.push({ id: newId(), name, unit: newUnit, pack_qty: packQty, pack_price: packPrice, deleted: false });
      }
      saveData();
      render();
      toast(ing ? 'Ingredient updated' : 'Ingredient added');
      return '';
    },
  });
}

async function deleteIngredient(id) {
  const ing = findIngredient(id);
  if (!ing) return;
  const usedIn = recipesUsing(id);
  const body = usedIn.length
    ? `<p><strong>${esc(ing.name)}</strong> is used in ${plural(usedIn.length, 'recipe')}:</p>
       <ul class="affected">${usedIn.map((r) => `<li>${esc(r.name)}</li>`).join('')}</ul>
       <p>Those recipes will show it as <strong>Missing</strong>, and their costs will be incomplete until you replace or remove it.</p>`
    : `<p><strong>${esc(ing.name)}</strong> isn't used in any recipes.</p>`;
  const ok = await openModal({ title: `Delete ${ing.name}?`, body, okLabel: 'Delete', danger: true });
  if (!ok) return;
  ing.deleted = true;
  saveData();
  render();
  toast(`${ing.name} deleted`);
}

/* =========================================================
   Packaging
   ========================================================= */

function renderPackaging(view) {
  const list = activePackaging();
  view.innerHTML = `
    <div class="view-head">
      <h1>Packaging</h1>
      <button class="btn btn-primary" data-action="pkg-add">+ Add packaging</button>
    </div>
    ${list.length ? `
      <div class="card table-wrap">
        <table class="list">
          <thead><tr><th>Name</th><th class="num">Price each</th><th></th></tr></thead>
          <tbody>
            ${list.map((p) => `
              <tr>
                <td><div class="name">${esc(p.name)}</div>${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}</td>
                <td class="num">${money(p.price)}</td>
                <td><div class="row-actions">
                  <button class="btn btn-small" data-action="pkg-edit" data-id="${esc(p.id)}">Edit</button>
                  <button class="btn btn-small btn-ghost-danger" data-action="pkg-delete" data-id="${esc(p.id)}">Delete</button>
                </div></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : emptyState('No packaging yet', 'Add boxes, bags, labels and liners with the price of one item. You pick them per batch in the calculator.',
      '<button class="btn btn-primary" data-action="pkg-add">+ Add packaging</button>')}`;
}

function editPackaging(id) {
  const item = id ? findPackaging(id) : null;
  openModal({
    title: item ? 'Edit packaging' : 'Add packaging',
    okLabel: item ? 'Save' : 'Add',
    body: `
      <label class="field"><span>Name</span>
        <input name="name" value="${esc(item?.name)}" autocomplete="off" autocapitalize="words" placeholder="e.g. Cupcake box"></label>
      <label class="field"><span>Description (optional)</span>
        <input name="description" value="${esc(item?.description)}" autocomplete="off" placeholder="e.g. 6-pack, window lid"></label>
      <label class="field"><span>Price per item</span>
        <div class="amount"><span class="pre">$</span><input name="price" inputmode="decimal" autocomplete="off" value="${item ? item.price : ''}" placeholder="e.g. 0.85"></div></label>`,
    onOk: (form) => {
      const name = fieldValue(form, 'name').trim();
      const description = fieldValue(form, 'description').trim();
      const price = parseNum(fieldValue(form, 'price'));
      if (!name) return 'Enter a name.';
      if (activePackaging().some((o) => o.id !== id && sameName(o.name, name))) {
        return `There's already packaging called “${name}”.`;
      }
      if (!(price >= 0)) return 'Price must be a number, e.g. 0.85.';
      if (item) {
        Object.assign(item, { name, description, price });
      } else {
        data.packaging.push({ id: newId(), name, description, price, deleted: false });
      }
      saveData();
      render();
      toast(item ? 'Packaging updated' : 'Packaging added');
      return '';
    },
  });
}

async function deletePackaging(id) {
  const item = findPackaging(id);
  if (!item) return;
  const ok = await openModal({
    title: `Delete ${item.name}?`,
    body: `<p>It will no longer appear in the calculator.</p>`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  item.deleted = true;
  saveData();
  render();
  toast(`${item.name} deleted`);
}

/* =========================================================
   Recipes
   ========================================================= */

/** The recipe being edited, as text fields: { id, isNew, name, yieldText, lines: [{ ingredient_id, amountText }], snapshot } */
let draft = null;

const draftSnapshot = (d) => JSON.stringify([d.name, d.yieldText, d.lines]);

function startRecipeDraft(id) {
  const r = id ? findRecipe(id) : null;
  draft = r
    ? {
      id: r.id,
      isNew: false,
      name: r.name,
      yieldText: String(r.yield_units),
      lines: r.ingredients.map((l) => ({ ingredient_id: l.ingredient_id, amountText: String(l.amount) })),
    }
    : { id: newId(), isNew: true, name: '', yieldText: '', lines: [{ ingredient_id: '', amountText: '' }] };
  draft.snapshot = draftSnapshot(draft);
  if (location.hash !== '#recipes') location.hash = 'recipes';
  else render();
  window.scrollTo(0, 0);
}

function renderRecipes(view) {
  if (draft) renderRecipeEditor(view);
  else renderRecipeList(view);
}

function renderRecipeList(view) {
  const recipes = [...data.recipes].sort(byName);
  const noIngredients = activeIngredients().length === 0;
  view.innerHTML = `
    <div class="view-head">
      <h1>Recipes</h1>
      <button class="btn btn-primary" data-action="recipe-new">+ New recipe</button>
    </div>
    ${recipes.length ? `
      <div class="cards">
        ${recipes.map((r) => {
          const c = ingredientCost(r);
          return `
            <article class="card recipe-card${c.missing.length ? ' has-missing' : ''}">
              <div class="recipe-head">
                <div>
                  <h2>${esc(r.name)}</h2>
                  <p class="muted">Makes ${qty(r.yield_units)} · ${plural(r.ingredients.length, 'ingredient')}</p>
                  ${c.missing.length ? `<p class="warn-text">⚠ Missing: ${c.missing.map(esc).join(', ')}</p>` : ''}
                </div>
                <div class="menu-wrap">
                  <button class="icon-btn menu-btn" data-action="menu-toggle" aria-haspopup="menu" aria-expanded="false" aria-label="Options for ${esc(r.name)}">⋯</button>
                  <div class="menu" role="menu" hidden>
                    <button role="menuitem" data-action="recipe-edit" data-id="${esc(r.id)}">Edit</button>
                    <button role="menuitem" data-action="recipe-duplicate" data-id="${esc(r.id)}">Duplicate</button>
                    <button role="menuitem" class="danger" data-action="recipe-delete" data-id="${esc(r.id)}">Delete</button>
                  </div>
                </div>
              </div>
              <div class="recipe-cost">
                <strong>${money(c.total)}</strong>
                <span class="muted">ingredients per batch · ${money(c.total / r.yield_units)} per unit${c.missing.length ? ' (incomplete)' : ''}</span>
              </div>
              ${c.missing.length ? `<div class="row-actions"><button class="btn btn-small btn-primary" data-action="recipe-edit" data-id="${esc(r.id)}">Fix missing ingredients</button></div>` : ''}
            </article>`;
        }).join('')}
      </div>`
    : emptyState('No recipes yet',
      noIngredients
        ? 'Add your ingredients first, then build a recipe from them.'
        : 'A recipe is a list of ingredients and amounts, plus how many units one batch makes.',
      noIngredients
        ? '<a class="btn btn-primary" href="#ingredients">Go to Ingredients</a>'
        : '<button class="btn btn-primary" data-action="recipe-new">+ New recipe</button>')}`;
}

function renderRecipeEditor(view) {
  const opts = activeIngredients();
  view.innerHTML = `
    <div class="view-head"><h1>${draft.isNew ? 'New recipe' : 'Edit recipe'}</h1></div>
    <div class="card">
      <div class="field-row">
        <label class="field grow"><span>Recipe name</span>
          <input data-draft="name" value="${esc(draft.name)}" autocomplete="off" autocapitalize="words" placeholder="e.g. Vanilla cupcakes"></label>
        <label class="field"><span>Yield (units per batch)</span>
          <input data-draft="yieldText" inputmode="decimal" autocomplete="off" value="${esc(draft.yieldText)}" placeholder="e.g. 12"></label>
      </div>
      <h2 class="section-title">Ingredients</h2>
      ${opts.length ? '' : '<p class="hint">You have no ingredients yet. <a href="#ingredients">Add some</a> — this draft will be kept while you do.</p>'}
      <div class="lines">${draft.lines.map((l, i) => recipeLineHTML(l, i, opts)).join('')}</div>
      <button class="btn" data-action="line-add">+ Add ingredient</button>
      <div class="draft-total" id="draft-total"></div>
      <p class="form-error" id="draft-error" role="alert" hidden></p>
      <div class="form-actions">
        <button class="btn" data-action="recipe-cancel">Cancel</button>
        <button class="btn btn-primary" data-action="recipe-save">Save recipe</button>
      </div>
    </div>`;
  updateDraftTotals();
}

function recipeLineHTML(line, i, opts) {
  const ing = line.ingredient_id ? findIngredient(line.ingredient_id) : null;
  if (line.ingredient_id && (!ing || ing.deleted)) {
    return `
      <div class="line line-missing">
        <div class="missing-label"><span class="badge-warn">Missing</span> ${esc(ing ? ing.name : 'Unknown ingredient')}
          <span class="muted">· ${esc(line.amountText)} ${ing ? unitLabel(ing.unit) : ''}</span></div>
        <select data-line="replace" data-idx="${i}" aria-label="Replace with another ingredient">
          <option value="">Replace with…</option>${options(opts, '')}
        </select>
        <button class="btn btn-small" data-action="line-remove" data-idx="${i}">Remove</button>
      </div>`;
  }
  return `
    <div class="line">
      <select data-line="ingredient" data-idx="${i}" aria-label="Ingredient">
        <option value="">Choose ingredient…</option>${options(opts, line.ingredient_id)}
      </select>
      <div class="amount">
        <input data-line="amount" data-idx="${i}" inputmode="decimal" autocomplete="off" value="${esc(line.amountText)}" placeholder="Amount" aria-label="Amount">
        <span class="unit">${ing ? unitLabel(ing.unit) : ''}</span>
      </div>
      <span class="line-cost" data-cost-idx="${i}"></span>
      <button class="icon-btn" data-action="line-remove" data-idx="${i}" aria-label="Remove line">✕</button>
    </div>`;
}

function updateDraftTotals() {
  let total = 0;
  let incomplete = false;
  draft.lines.forEach((line, i) => {
    const ing = line.ingredient_id ? findIngredient(line.ingredient_id) : null;
    const cell = $(`[data-cost-idx="${i}"]`);
    if (!ing || ing.deleted) {
      if (line.ingredient_id) incomplete = true;
      return;
    }
    const amount = parseNum(line.amountText);
    const input = $(`[data-line="amount"][data-idx="${i}"]`);
    if (input) input.classList.toggle('invalid', line.amountText.trim() !== '' && !Number.isFinite(amount));
    if (!Number.isFinite(amount)) {
      if (cell) cell.textContent = '';
      return;
    }
    const cost = amount * unitCost(ing);
    total += cost;
    if (cell) cell.textContent = money(cost);
  });
  const y = parseNum(draft.yieldText);
  $('#draft-total').innerHTML = `Ingredient cost: <strong class="money">${money(total)}</strong> per batch${
    y > 0 ? ` · <strong class="money">${money(total / y)}</strong> per unit` : ''}${
    incomplete ? ' <span class="warn-text">— incomplete, missing ingredients excluded</span>' : ''}`;
}

function replaceLineIngredient(idx, newIngredientId) {
  const line = draft.lines[idx];
  const oldIng = findIngredient(line.ingredient_id);
  const newIng = findIngredient(newIngredientId);
  if (!newIng) return;
  line.ingredient_id = newIngredientId;
  render();
  if (oldIng && oldIng.unit !== newIng.unit) {
    toast(`Amount kept as ${line.amountText} — now in ${unitLabel(newIng.unit)}. Check it's right.`);
  } else {
    toast(`Replaced with ${newIng.name}`);
  }
}

function saveDraft() {
  const errorEl = $('#draft-error');
  const fail = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    errorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const name = draft.name.trim();
  if (!name) return fail('Give the recipe a name.');
  if (data.recipes.some((r) => r.id !== draft.id && sameName(r.name, name))) {
    return fail(`There's already a recipe called “${name}”.`);
  }
  const yieldUnits = parseNum(draft.yieldText);
  if (!(yieldUnits > 0)) return fail('Yield must be a number above 0 — how many units one batch makes.');

  const lines = [];
  for (const [i, line] of draft.lines.entries()) {
    if (!line.ingredient_id && !line.amountText.trim()) continue; // untouched blank row
    if (!line.ingredient_id) return fail(`Line ${i + 1}: choose an ingredient, or remove the line.`);
    const amount = parseNum(line.amountText);
    if (!(amount > 0)) return fail(`Line ${i + 1}: the amount must be a number above 0.`);
    lines.push({ ingredient_id: line.ingredient_id, amount });
  }
  if (!lines.length) return fail('Add at least one ingredient.');

  const recipe = { id: draft.id, name, yield_units: yieldUnits, ingredients: lines };
  const idx = data.recipes.findIndex((r) => r.id === draft.id);
  if (idx >= 0) data.recipes[idx] = recipe;
  else data.recipes.push(recipe);
  if (!saveData()) return;
  draft = null;
  render();
  window.scrollTo(0, 0);
  toast('Recipe saved');
}

async function cancelDraft() {
  if (draftSnapshot(draft) !== draft.snapshot) {
    const ok = await openModal({
      title: 'Discard changes?',
      body: '<p>Your changes to this recipe will be lost.</p>',
      okLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (!ok) return;
  }
  draft = null;
  render();
}

function duplicateRecipe(id) {
  const r = findRecipe(id);
  if (!r) return;
  // Suggest "<name> copy", or "<name> copy 2" and so on if that's taken.
  let suggestion = `${r.name} copy`;
  for (let n = 2; data.recipes.some((x) => sameName(x.name, suggestion)); n++) suggestion = `${r.name} copy ${n}`;
  openModal({
    title: `Duplicate ${r.name}?`,
    okLabel: 'Duplicate',
    body: `
      <p>This makes a separate copy with the same ingredients and yield. Changes to one won't affect the other.</p>
      <label class="field"><span>Name for the copy</span>
        <input name="name" value="${esc(suggestion)}" autocomplete="off" autocapitalize="words"></label>`,
    onOpen: (form) => setTimeout(() => form.elements.namedItem('name').select(), 0),
    onOk: (form) => {
      const name = fieldValue(form, 'name').trim();
      if (!name) return 'Enter a name for the copy.';
      if (data.recipes.some((x) => sameName(x.name, name))) return `There's already a recipe called “${name}”.`;
      data.recipes.push({
        id: newId(),
        name,
        yield_units: r.yield_units,
        ingredients: r.ingredients.map((l) => ({ ingredient_id: l.ingredient_id, amount: l.amount })),
      });
      saveData();
      render();
      toast(`Created ${name}`);
      return '';
    },
  });
}

async function deleteRecipe(id) {
  const r = findRecipe(id);
  if (!r) return;
  const ok = await openModal({
    title: `Delete ${r.name}?`,
    body: '<p>This removes the recipe for good. Ingredients are not affected.</p>',
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  data.recipes = data.recipes.filter((x) => x.id !== id);
  if (calc.recipeId === id) calc.recipeId = '';
  saveData();
  render();
  toast(`${r.name} deleted`);
}

/* =========================================================
   Calculator (live only — nothing here is saved)
   ========================================================= */

const calc = {
  recipeId: '',
  labour: '',
  bake: '',
  misc: '',
  packs: [], // { packaging_id, qty }
  mode: 'margin', // 'margin' → show price, 'price' → show margin
  margin: '',
  marginTouched: false,
  price: '',
};

function resetCalc() {
  Object.assign(calc, { recipeId: '', labour: '', bake: '', misc: '', packs: [], margin: '', marginTouched: false, price: '' });
}

function computeBatch() {
  const recipe = findRecipe(calc.recipeId);
  if (!recipe) return null;
  const s = data.settings;
  const errors = [];
  const read = (text, parse, label) => {
    if (!String(text).trim()) return 0;
    const v = parse(text);
    if (!Number.isFinite(v)) errors.push(label);
    return v;
  };

  const ing = ingredientCost(recipe);
  const hours = read(calc.labour, parseHours, 'labour time');
  const bakeMin = read(calc.bake, parseNum, 'bake time');
  const misc = read(calc.misc, parseNum, 'misc cost');

  let packaging = 0;
  let packCount = 0;
  calc.packs.forEach((p, i) => {
    const item = findPackaging(p.packaging_id);
    if (!item) return;
    const q = read(p.qty, parseNum, `packaging line ${i + 1}`);
    packaging += q * item.price;
    packCount += q;
  });

  const electricity = (bakeMin / 60) * s.oven_kw * s.electricity_per_kwh;
  const labour = hours * s.labour_rate_per_hr;
  const total = ing.total + electricity + labour + packaging + misc;
  return {
    recipe, ing, hours, bakeMin, electricity, labour, packaging, packCount, misc, total,
    perUnit: total / recipe.yield_units,
    errors,
  };
}

function renderCalculator(view) {
  if (calc.recipeId && !findRecipe(calc.recipeId)) calc.recipeId = '';
  calc.packs = calc.packs.filter((p) => {
    if (!p.packaging_id) return true;
    const item = findPackaging(p.packaging_id);
    return item && !item.deleted;
  });
  if (!calc.marginTouched) calc.margin = String(data.settings.default_margin_pct);

  const recipes = [...data.recipes].sort(byName);
  if (!recipes.length) {
    view.innerHTML = `
      <div class="view-head"><h1>Calculator</h1></div>
      ${emptyState('No recipes yet', 'Save a recipe first, then come back here to cost a batch and set a price.',
        '<a class="btn btn-primary" href="#recipes">Go to Recipes</a>')}`;
    return;
  }

  const packOpts = activePackaging();
  view.innerHTML = `
    <div class="view-head">
      <h1>Calculator</h1>
      <button class="btn btn-ghost" data-action="calc-clear">Clear inputs</button>
    </div>
    <div class="calc-grid">
      <section class="card" aria-label="Batch inputs">
        <label class="field"><span>Recipe</span>
          <select data-calc="recipeId"><option value="">Choose a recipe…</option>${options(recipes, calc.recipeId)}</select></label>
        <div class="field-row">
          <label class="field"><span>Labour time</span>
            <div class="amount"><input data-calc="labour" inputmode="decimal" autocomplete="off" value="${esc(calc.labour)}" placeholder="1.5 or 1:30"><span class="unit">hours</span></div></label>
          <label class="field"><span>Bake time</span>
            <div class="amount"><input data-calc="bake" inputmode="decimal" autocomplete="off" value="${esc(calc.bake)}" placeholder="e.g. 25"><span class="unit">min</span></div></label>
        </div>
        <div class="field"><span>Packaging</span>
          ${calc.packs.length ? `<div class="lines">${calc.packs.map((p, i) => `
            <div class="line">
              <select data-pack="packaging_id" data-idx="${i}" aria-label="Packaging item">
                <option value="">Choose packaging…</option>${options(packOpts, p.packaging_id)}
              </select>
              <div class="amount"><input data-pack="qty" data-idx="${i}" inputmode="decimal" autocomplete="off" value="${esc(p.qty)}" aria-label="Quantity"><span class="unit">qty</span></div>
              <span class="line-cost" data-pack-cost="${i}"></span>
              <button class="icon-btn" data-action="calc-pack-remove" data-idx="${i}" aria-label="Remove packaging">✕</button>
            </div>`).join('')}</div>` : ''}
          ${packOpts.length
            ? '<div><button class="btn" data-action="calc-pack-add">+ Add packaging</button></div>'
            : '<p class="hint">No packaging items yet. <a href="#packaging">Add them in Packaging</a>.</p>'}
        </div>
        <label class="field"><span>Misc cost</span>
          <div class="amount"><span class="pre">$</span><input data-calc="misc" inputmode="decimal" autocomplete="off" value="${esc(calc.misc)}" placeholder="0.00"></div></label>
      </section>
      <section class="card results" aria-label="Results">
        <div id="calc-breakdown"></div>
        <div class="pricing" id="calc-pricing">${pricingHTML()}</div>
      </section>
    </div>`;
  updateCalcOutputs();
}

function pricingHTML() {
  const marginMode = calc.mode === 'margin';
  return `
    <h2 class="section-title">Price per unit</h2>
    <div class="seg" role="group" aria-label="Pricing mode">
      <button type="button" class="${marginMode ? 'on' : ''}" aria-pressed="${marginMode}" data-action="calc-mode" data-mode="margin">Set margin → price</button>
      <button type="button" class="${marginMode ? '' : 'on'}" aria-pressed="${!marginMode}" data-action="calc-mode" data-mode="price">Set price → margin</button>
    </div>
    ${marginMode
      ? `<label class="field"><span>Margin (% of selling price)</span>
           <div class="amount"><input data-calc="margin" inputmode="decimal" autocomplete="off" value="${esc(calc.margin)}"><span class="unit">%</span></div></label>`
      : `<label class="field"><span>Selling price per unit</span>
           <div class="amount"><span class="pre">$</span><input data-calc="price" inputmode="decimal" autocomplete="off" value="${esc(calc.price)}" placeholder="e.g. 3.50"></div></label>`}
    <div class="price-out" id="calc-price-out" aria-live="polite"></div>`;
}

function updateCalcOutputs() {
  const box = $('#calc-breakdown');
  if (!box) return;
  const out = $('#calc-price-out');

  // Inline cost per packaging line, and red outline on unreadable inputs.
  calc.packs.forEach((p, i) => {
    const cell = $(`[data-pack-cost="${i}"]`);
    const item = findPackaging(p.packaging_id);
    const q = parseNum(p.qty);
    if (cell) cell.textContent = item && Number.isFinite(q) ? money(q * item.price) : '';
    $(`[data-pack="qty"][data-idx="${i}"]`)?.classList.toggle('invalid', p.qty.trim() !== '' && !Number.isFinite(q));
  });
  const flag = (key, parse) => {
    const v = calc[key];
    $(`[data-calc="${key}"]`)?.classList.toggle('invalid', String(v).trim() !== '' && !Number.isFinite(parse(v)));
  };
  flag('labour', parseHours);
  flag('bake', parseNum);
  flag('misc', parseNum);
  flag('margin', parseNum);
  flag('price', parseNum);

  const b = computeBatch();
  if (!b) {
    box.innerHTML = '<p class="placeholder">Choose a recipe to see the cost breakdown.</p>';
    out.innerHTML = '';
    return;
  }

  const s = data.settings;
  const missing = b.ing.missing;
  box.innerHTML = `
    ${missing.length ? `
      <div class="alert alert-warn"><strong>Cost is incomplete.</strong>
        This recipe has missing ingredients (${missing.map(esc).join(', ')}), which are left out of the cost.
        <button class="link-btn" data-action="recipe-edit" data-id="${esc(b.recipe.id)}">Fix recipe</button></div>` : ''}
    ${b.errors.length ? `
      <div class="alert alert-error">Check the ${b.errors.map(esc).join(', ')}. Use plain numbers like 2.5${
        b.errors.includes('labour time') ? ' (labour can also be h:mm, like 1:30)' : ''}.</div>` : ''}
    <h2 class="section-title">Batch cost · ${esc(b.recipe.name)}</h2>
    <table class="breakdown">
      <tr><th>Ingredients${missing.length ? ' <span class="badge-warn">incomplete</span>' : ''}</th><td>${money(b.ing.total)}</td></tr>
      <tr><th>Electricity<small>${qty(b.bakeMin)} min × ${qty(s.oven_kw)} kW × ${fineMoney(s.electricity_per_kwh)}/kWh</small></th><td>${money(b.electricity)}</td></tr>
      <tr><th>Labour<small>${qty(b.hours)} h × ${money(s.labour_rate_per_hr)}/h</small></th><td>${money(b.labour)}</td></tr>
      <tr><th>Packaging<small>${plural(b.packCount, 'item')}</small></th><td>${money(b.packaging)}</td></tr>
      <tr><th>Misc</th><td>${money(b.misc)}</td></tr>
      <tr class="total"><th>Total batch cost</th><td>${money(b.total)}</td></tr>
    </table>
    <div class="per-unit">
      <span>Cost per unit<small>${money(b.total)} ÷ ${plural(b.recipe.yield_units, 'unit')}</small></span>
      <strong>${money(b.perUnit)}</strong>
    </div>`;
  out.innerHTML = priceOutputHTML(b);
}

function priceOutputHTML(b) {
  const cost = b.perUnit;
  const units = b.recipe.yield_units;
  if (!Number.isFinite(cost)) return '<p class="placeholder">Fix the inputs above to see a price.</p>';

  if (calc.mode === 'margin') {
    const m = parseNum(calc.margin);
    if (!Number.isFinite(m)) return '<p class="neg-text">Enter a margin, for example 30.</p>';
    if (m >= 100) return '<p class="neg-text">Margin must be below 100%.</p>';
    const price = cost / (1 - m / 100);
    return `
      <div class="big-result"><span>Selling price per unit</span><strong>${money(price)}</strong></div>
      <p class="muted">Profit ${money(price - cost)} per unit · ${money((price - cost) * units)} per batch</p>`;
  }

  const price = parseNum(calc.price);
  if (!(price > 0)) return '<p class="muted">Enter a selling price to see your margin.</p>';
  const margin = ((price - cost) / price) * 100;
  const loss = margin < 0;
  return `
    <div class="big-result${loss ? ' negative' : ''}"><span>Margin</span><strong>${pct(margin)}</strong></div>
    <p class="${loss ? 'neg-text' : 'muted'}">${loss ? `Loss of ${money(cost - price)} per unit` : `Profit ${money(price - cost)} per unit`} · ${
      money((price - cost) * units)} per batch</p>`;
}

/* =========================================================
   Settings
   ========================================================= */

const SETTING_FIELDS = [
  { key: 'labour_rate_per_hr', label: 'Labour rate', pre: '$', post: 'per hour', hint: 'What you pay yourself or staff for an hour of work.' },
  { key: 'electricity_per_kwh', label: 'Electricity price', pre: '$', post: 'per kWh', hint: 'The per-kWh rate on your power bill.' },
  { key: 'oven_kw', label: 'Oven power', pre: '', post: 'kW', hint: "On the oven's rating plate or manual. Many home ovens are 2–3.5 kW." },
  { key: 'default_margin_pct', label: 'Default margin', pre: '', post: '%', hint: 'The calculator starts here. Margin is a percentage of the selling price.' },
];

function renderSettings(view) {
  const exp = lastExportInfo();
  const counts = `${plural(data.ingredients.filter((i) => !i.deleted).length, 'ingredient')}, ${
    plural(data.packaging.filter((p) => !p.deleted).length, 'packaging item')}, ${plural(data.recipes.length, 'recipe')}`;
  view.innerHTML = `
    <div class="view-head"><h1>Settings</h1><span class="saved-note" id="saved-note" hidden>Saved</span></div>
    <section class="card">
      <h2 class="section-title">Costs</h2>
      <div class="settings-grid">
        ${SETTING_FIELDS.map((f) => `
          <label class="field"><span>${esc(f.label)}</span>
            <div class="amount">${f.pre ? `<span class="pre">${f.pre}</span>` : ''}<input data-setting="${f.key}" inputmode="decimal" autocomplete="off" value="${data.settings[f.key]}"><span class="unit">${esc(f.post)}</span></div>
            <small class="hint">${esc(f.hint)}</small>
            <small class="field-error" data-setting-error="${f.key}" hidden></small>
          </label>`).join('')}
      </div>
      <p class="hint">Changes save as you type.</p>
    </section>
    <section class="card">
      <h2 class="section-title">Your data</h2>
      <p class="export-status${exp.stale && hasAnyData() ? ' stale' : ''}">Last exported: <strong>${esc(exp.text)}</strong></p>
      ${exp.stale && hasAnyData() ? '<p class="warn-text">Time to make a backup.</p>' : ''}
      <div class="btn-row">
        <button class="btn btn-primary" data-action="export">Export data</button>
        <button class="btn" data-action="import">Import data…</button>
      </div>
      <p class="hint">Everything is stored only on this device, inside this app. Export regularly and save the file to Files or iCloud Drive. Importing a file replaces everything.</p>
      <p class="hint" id="persist-status"></p>
      <p class="hint">Currently stored: ${counts}.</p>
    </section>`;
  updatePersistStatus();
}

async function updatePersistStatus() {
  const el = $('#persist-status');
  if (!el || !navigator.storage || typeof navigator.storage.persisted !== 'function') return;
  try {
    const persisted = await navigator.storage.persisted();
    el.textContent = persisted
      ? 'Storage is marked as persistent, so the browser should not clear it on its own.'
      : "Storage isn't marked as persistent yet, so keep your exports up to date.";
  } catch { /* ignore */ }
}

function onSettingInput(input) {
  const key = input.dataset.setting;
  const value = parseNum(input.value);
  const errorEl = $(`[data-setting-error="${key}"]`);
  let problem = '';
  if (!Number.isFinite(value)) problem = 'Enter a number (digits and a decimal point).';
  else if (key === 'default_margin_pct' && value >= 100) problem = 'Margin must be below 100%.';
  input.classList.toggle('invalid', !!problem);
  errorEl.textContent = problem;
  errorEl.hidden = !problem;
  if (problem) return;
  data.settings[key] = value;
  if (saveData()) {
    const note = $('#saved-note');
    note.hidden = false;
    clearTimeout(onSettingInput.timer);
    onSettingInput.timer = setTimeout(() => { note.hidden = true; }, 1500);
  }
}

/* =========================================================
   Navigation & events
   ========================================================= */

const VIEWS = {
  calculator: renderCalculator,
  recipes: renderRecipes,
  ingredients: renderIngredients,
  packaging: renderPackaging,
  settings: renderSettings,
};

function currentTab() {
  const tab = location.hash.slice(1);
  return TABS.includes(tab) ? tab : 'calculator';
}

function render() {
  const tab = currentTab();
  $$('.app-header [data-tab]').forEach((a) => {
    const active = a.dataset.tab === tab;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // Gentle backup nudge on the Settings gear.
  $('.settings-link').classList.toggle('attention', hasAnyData() && lastExportInfo().stale);
  VIEWS[tab]($('#view'));
}

const ACTIONS = {
  'ing-add': () => editIngredient(null),
  'ing-edit': (el) => editIngredient(el.dataset.id),
  'ing-delete': (el) => deleteIngredient(el.dataset.id),
  'pkg-add': () => editPackaging(null),
  'pkg-edit': (el) => editPackaging(el.dataset.id),
  'pkg-delete': (el) => deletePackaging(el.dataset.id),
  'recipe-new': () => startRecipeDraft(null),
  'recipe-edit': (el) => startRecipeDraft(el.dataset.id),
  'recipe-duplicate': (el) => duplicateRecipe(el.dataset.id),
  'recipe-delete': (el) => deleteRecipe(el.dataset.id),
  'menu-toggle': (el) => {
    const menu = el.nextElementSibling;
    const opening = menu.hidden;
    closeMenus();
    menu.hidden = !opening;
    el.setAttribute('aria-expanded', String(opening));
    if (opening) menu.querySelector('button').focus();
  },
  'recipe-save': () => saveDraft(),
  'recipe-cancel': () => cancelDraft(),
  'line-add': () => {
    draft.lines.push({ ingredient_id: '', amountText: '' });
    render();
    $$('[data-line="ingredient"]').pop()?.focus();
  },
  'line-remove': (el) => {
    draft.lines.splice(Number(el.dataset.idx), 1);
    render();
  },
  'calc-pack-add': () => {
    calc.packs.push({ packaging_id: '', qty: '1' });
    render();
  },
  'calc-pack-remove': (el) => {
    calc.packs.splice(Number(el.dataset.idx), 1);
    render();
  },
  'calc-mode': (el) => {
    if (calc.mode === el.dataset.mode) return;
    // Carry the current price over so switching modes starts from something sensible.
    if (el.dataset.mode === 'price' && !calc.price.trim()) {
      const b = computeBatch();
      const m = parseNum(calc.margin);
      if (b && Number.isFinite(b.perUnit) && m < 100) calc.price = (b.perUnit / (1 - m / 100)).toFixed(2);
    }
    calc.mode = el.dataset.mode;
    $('#calc-pricing').innerHTML = pricingHTML();
    updateCalcOutputs();
  },
  'calc-clear': () => {
    const { recipeId, mode } = calc;
    resetCalc();
    Object.assign(calc, { recipeId, mode });
    render();
  },
  export: () => exportData(),
  import: () => $('#import-file').click(),
};

function closeMenus() {
  $$('.menu:not([hidden])').forEach((menu) => {
    menu.hidden = true;
    menu.previousElementSibling.setAttribute('aria-expanded', 'false');
  });
}

function onViewClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = ACTIONS[el.dataset.action];
  if (!action) return;
  e.preventDefault();
  if (el.dataset.action !== 'menu-toggle') closeMenus();
  action(el);
}

function onViewInput(e) {
  const el = e.target;
  // Selects are handled on 'change' only, text fields on 'input' only.
  if ((el.tagName === 'SELECT') !== (e.type === 'change')) return;

  if (el.dataset.calc) {
    calc[el.dataset.calc] = el.value;
    if (el.dataset.calc === 'margin') calc.marginTouched = true;
    updateCalcOutputs();
  } else if (el.dataset.pack) {
    const p = calc.packs[Number(el.dataset.idx)];
    if (el.dataset.pack === 'qty') p.qty = el.value;
    else p.packaging_id = el.value;
    updateCalcOutputs();
  } else if (el.dataset.draft) {
    draft[el.dataset.draft] = el.value;
    updateDraftTotals();
  } else if (el.dataset.line === 'amount') {
    draft.lines[Number(el.dataset.idx)].amountText = el.value;
    updateDraftTotals();
  } else if (el.dataset.line === 'ingredient') {
    draft.lines[Number(el.dataset.idx)].ingredient_id = el.value;
    render();
  } else if (el.dataset.line === 'replace') {
    if (el.value) replaceLineIngredient(Number(el.dataset.idx), el.value);
  } else if (el.dataset.setting) {
    onSettingInput(el);
  }
}

function init() {
  data = loadData();
  requestPersistentStorage();

  const view = $('#view');
  view.addEventListener('click', onViewClick);
  view.addEventListener('input', onViewInput);
  view.addEventListener('change', onViewInput);
  // Close an open ⋯ menu on a tap outside it, or on Escape.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });
  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });

  render();
  if (loadProblem) alertModal('Saved data problem', loadProblem);
}

init();
