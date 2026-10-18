# Baking Cost Calculator — Prototype Build Plan

## Goal
A simple, practical calculator for a small baking business: work out what a batch costs and what to charge per unit. It must be useful without being overwhelming. Keep scope tight.

## Platform
- Runs in the browser on an **iPad**, launched from a **Home Screen icon** (web app).
- **Plain HTML + CSS + vanilla JavaScript**, no framework and no build step.
- Hosted on a free HTTPS static host (e.g., GitHub Pages). It must be served over HTTPS so it works as a Home Screen web app.
- Include a web app manifest and the Apple Home Screen meta tags (`apple-mobile-web-app-capable`, an icon, a title).
- Touch-friendly layout sized for iPad, in both portrait and landscape.

## Data model
All data lives in one JSON structure, saved to browser storage.

```json
{
  "version": 1,
  "settings": {
    "labour_rate_per_hr": 20.00,
    "electricity_per_kwh": 0.10,
    "oven_kw": 3.0,
    "default_margin_pct": 30
  },
  "ingredients": [
    { "id": "uuid", "name": "Flour", "unit": "g",    "pack_qty": 10000, "pack_price": 12.99, "deleted": false },
    { "id": "uuid", "name": "Eggs",  "unit": "each", "pack_qty": 12,    "pack_price": 4.29,  "deleted": false }
  ],
  "packaging": [
    { "id": "uuid", "name": "Cupcake box", "description": "6-pack", "price": 0.85, "deleted": false }
  ],
  "recipes": [
    {
      "id": "uuid",
      "name": "Vanilla cupcakes",
      "yield_units": 12,
      "ingredients": [ { "ingredient_id": "uuid", "amount": 300 } ]
    }
  ]
}
```

Rules:
- `unit` is either `"g"` or `"each"`. A recipe line's `amount` is in that ingredient's unit.
- Cost per unit is **derived**, never stored: `pack_price / pack_qty`.
- Recipes store **only ingredient IDs and amounts**, never costs, so price changes propagate automatically.
- IDs come from `crypto.randomUUID()`.
- `version` is there for future migrations.

## Features

### 1. Ingredients (add / edit / delete)
- Fields: name, unit (g / each), pack quantity, pack price.
- The list shows the derived cost per gram or cost each.
- **Delete is a soft delete:**
  - Before deleting, show a warning that lists every recipe using the ingredient. Deletion is **not blocked**.
  - On confirm, set `deleted: true` and hide the ingredient from the ingredient list and from pickers.
- Deleted ingredients stay in storage so recipes can still show their name.

### 2. Packaging (add / edit / delete)
- Fields: name, description, price (per item).
- Use the same soft delete as ingredients. A warning isn't needed, because packaging isn't stored in recipes.

### 3. Recipes (save / load / edit / delete)
- Fields: name, yield (units per batch), and ingredient lines (an ingredient picker plus an amount in that ingredient's unit).
- **Missing ingredients:** if a line points to a deleted ingredient:
  - Show "Missing: <name>".
  - Offer **Replace** (pick another ingredient and keep the amount) and **Remove** (drop the line).
  - The calculator must flag that a recipe has missing ingredients and exclude those lines from the cost. Show a visible warning that the cost is incomplete.

### 4. Calculator
1. Select a saved recipe.
2. Enter the inputs for this batch:
   - Labour time (hours, decimal or h:mm)
   - Bake time (minutes)
   - Packaging: pick items and quantities
   - Misc cost ($)
3. Show a per-batch cost breakdown:
   - Ingredients = Σ amount × (pack_price / pack_qty)
   - Electricity = (bake_min / 60) × oven_kw × electricity_per_kwh
   - Labour = hours × labour_rate_per_hr
   - Packaging = Σ qty × price
   - Misc = entered amount
   - **Total batch cost**, and **cost per unit** = total ÷ yield_units
4. **Pricing toggle** (per unit):
   - **Fixed margin → show price.** Price = cost_per_unit ÷ (1 − margin). The margin starts at the default from settings.
   - **Fixed price → show margin.** Margin = (price − cost_per_unit) ÷ price. Show it in red if negative.
   - "Margin" means a **percentage of the selling price**, not markup on cost.
5. Round displayed money to cents. Calculate internally at full precision.
6. **Calculations are not saved.** The calculator is a live tool only.

### 5. Settings
- Edit the labour rate, the electricity price ($/kWh), the oven power (kW), and the default margin %.

### 6. Data safety
- Store data in localStorage under a single key (IndexedDB is optional; the data is small).
- On launch, call `navigator.storage.persist()` if it's available.
- **Export:** download the full JSON as `baking-data-YYYY-MM-DD.json` so it can be saved to Files or iCloud Drive.
- **Import:** pick a JSON file and validate its shape and `version`. Confirm with "This will replace all current data", then replace.
- Show a "Last exported: <date>" reminder in Settings.

## Out of scope (do not build)
- Accounts, cloud sync, or a backend
- Saved quotes or calculation history
- Fixed costs (insurance, etc.)
- Inventory or stock tracking
- Unit conversions (cups, ml, oz, etc.)
- Offline service worker (optional later; not needed for the prototype)

## Build order
1. Data layer: load, save, defaults, `persist()`, and export/import.
2. Settings screen.
3. Ingredients CRUD with soft delete and the affected-recipes warning.
4. Packaging CRUD.
5. Recipes CRUD with missing-ingredient Replace/Remove.
6. Calculator with the breakdown and the margin/price toggle.
7. Manifest, Home Screen meta tags, icon, and iPad layout pass.

## Acceptance checks
- Changing an ingredient's pack price updates the cost of every recipe that uses it.
- Ingredient costs are correct for both `g` and `each` ingredients.
- Deleting a used ingredient lists the affected recipes. After confirming, those recipes show it as missing with working Replace and Remove.
- At 30% margin, a unit costing $1.00 is priced at $1.43, and a $2.00 price shows a 50% margin.
- Electricity: 30 min at 3 kW and $0.10/kWh comes to $0.15.
- Export, then clear storage, then import restores everything exactly.
- The app installs to the iPad Home Screen and keeps its data across closing and reopening.

## Open question
- Assumed **single user on one iPad**. If several people or devices need the same data, revisit storage (cloud sync) before building.
