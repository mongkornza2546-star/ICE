# Employee full/half bag entry

React + TypeScript (Vite), Supabase/PostgreSQL. Changes are limited to employee stock entry, its RPCs and reference data.

## Migration and deployment

Apply migrations through `supabase/migrations/0229_employee_stock_no_overdraw.sql` before deploying the frontend. Migration 0229 replaces the three employee stock RPCs to reject overdraw even when an older client sends `confirmedOverstock: true`. Use the project's normal Supabase migration workflow (`supabase db push` for an already-linked project; inspect pending migrations first). No production migration was applied as part of this change.

- `ice_types.allow_half` defaults to true; the migration sets it false for the exact product name `หลอดเล็กโม่`. The employee reference query maps it to `allowHalf`.
- `stock_movement_items.full_bags` and `half_bags` are nullable integers. New employee requests send `fullBags`, `halfBags`, and computed `quantity`. Database validation requires nonnegative integers whose total matches quantity, and rejects half bags for products that disallow them.
- Existing rows retain their original quantity with null split columns; no historical split is guessed. Existing quantity-based reports continue to work.
- All three employee RPCs keep their signatures, authorization, round/day locks and idempotency. A new split is part of request identity; retries create no additional movement. Recovered quantity-only drafts reuse their legacy pending key and payload until acknowledged. Return/damage fingerprints remain compatible with pre-0218 movements. Overstock is rejected for all new writes. Already-committed requests still return their result before checking current balances, so retrying creates no new movement.
- All excess stock is blocked. Return and damage subtract from the courier's holding stock; receive subtracts from the truck. Damage also checks the aggregate. New clients no longer send an overstock flag, and the database ignores that flag from older clients.
- Other products can be configured using `update public.ice_types set allow_half = false where id = '<product UUID>';` in the normal database administration workflow. No catalog editor changes are included.

## Manual acceptance checks

1. Start with 20 bags on the truck. Type full 14, half 1: card and button show 14.5 bags; remaining preview shows 5.5. Save: both inputs reset to zero, remaining stays 5.5, green success appears, and exactly one movement contains 14 / 1 / 14.5.
2. Set a product's `allow_half` false and reload reference data. Half input is absent; full input fills the row. API requests with half bags are rejected for that product.
3. Save another quantity after step 1: remaining decreases again and a separate movement is created. Retrying the same pending request after a network failure creates only one movement.
4. Click save with all zeros: red validation appears below the button, no RPC. Edit full then half and click Undo: only the last edit is undone. Successful save clears Undo history.
5. Simulate a rejected RPC/offline failure: inputs remain, retry message appears, retry uses the same request key. Try entering more than source stock: the edit is rejected; full/half increment buttons disable when their next increment would exceed stock. If a recovered draft or stock refresh leaves the entered quantity above stock, Save is disabled and the submit handler also rejects it unless it matches an existing pending request exactly. In that case the action explicitly checks the previous result using its original key and payload; the database still rejects any uncommitted request that would overdraw. Reducing or clearing the quantity remains available.
6. Switch to Burmese: counter labels, balance previews, warnings, Undo/Save and success/error feedback are translated. Switching back to Thai preserves inputs and translates the success message.
7. Repeat on return and damage. Their source is courier holding stock; returning increases truck stock. Check 360px and dark mode: no horizontal overflow; equal card heights with image/fallback; 44px-wide, 48px-high step buttons; last card scrolls clear of the fixed save bar.

## Automated verification

```sh
npx vitest run tests/employee-stock-damage.test.tsx tests/employee-live-shop-refresh.test.tsx --maxWorkers=1 --no-file-parallelism
node --test tests/employee-stock-transfer.integration.test.mjs tests/employee-stock-damage-contract.test.mjs
npm run build
```

Database integration tests run the migration in isolated PGlite PostgreSQL, including all three RPCs, split validation, allowHalf, historical totals, source balances, retries across migration and balance refresh, and rejection of overstock including old confirmation flags. UI tests recover legacy numeric drafts with their original pending request keys and verify Burmese feedback. Browser preview at 360px verified equal card heights and document width of 360px in dark mode.

## Overstock regression (2026-10-14)

The previous form deliberately allowed an overstock confirmation, and migration 0218 skipped both source and aggregate balance checks when `confirmedOverstock` was true. This allowed returns from empty holding stock and negative balances. Regression tests first reproduced enabled increment/save controls and successful overdraw in all three RPCs. Migration 0229 removes that bypass while preserving authorization, day locks, split validation and idempotent retries. The UI blocks increases past available stock and refuses new overstock requests. An exact pending request can be retried to reconcile a lost response without creating another movement. The demo gateway also validates balances before mutation.

Checks cover zero stock, full/half combined limits, recovered drafts, direct submit-handler calls, valid exact-balance saves, rejected legacy confirmation flags, aggregate damage limits and existing request retries. Tests use isolated fixtures; production data is not modified or repaired by this change.

Review follow-up: request identity is now resolved before the client balance guard and shared with the button state. Split and legacy quantity-only retries retain the original key and payload after a stock refresh; editing the quantity removes that exception. A rejected retry keeps its draft and displays the server error. `normalizeBags` applies `allowHalf` consistently to counter totals, edited values and request payloads, so hidden half bags in recovered drafts do not prevent valid full-bag entry. UI regressions exercise lost responses and stock refreshes in all three modes, legacy recovery at zero stock, edited pending drafts, rejected uncommitted retries and hidden half-bag recovery.
