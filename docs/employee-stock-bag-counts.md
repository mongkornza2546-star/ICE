# Employee full/half bag entry

React + TypeScript (Vite), Supabase/PostgreSQL. Changes are limited to employee stock entry, its RPCs and reference data.

## Migration and deployment

Apply `supabase/migrations/0218_employee_stock_bag_counts.sql` after migrations through 0217, before deploying the frontend. Use the project's normal Supabase migration workflow (`supabase db push` for an already-linked project; inspect pending migrations first). No production migration was applied as part of this change.

- `ice_types.allow_half` defaults to true; the migration sets it false for the exact product name `หลอดเล็กโม่`. The employee reference query maps it to `allowHalf`.
- `stock_movement_items.full_bags` and `half_bags` are nullable integers. New employee requests send `fullBags`, `halfBags`, and computed `quantity`. Database validation requires nonnegative integers whose total matches quantity, and rejects half bags for products that disallow them.
- Existing rows retain their original quantity with null split columns; no historical split is guessed. Existing quantity-based reports continue to work.
- All three employee RPCs keep their signatures, authorization, round/day locks and idempotency. A new split is part of request identity; retries create no additional movement. Recovered quantity-only drafts reuse their legacy pending key and payload until acknowledged. Return/damage fingerprints remain compatible with pre-0218 movements. Overstock confirmation is validated for new writes and audited, but is excluded from retry identity so a stock refresh cannot invalidate a committed request.
- Confirmed excess stock is sent as `confirmedOverstock: true`, permits a negative source balance, and is recorded in the audit entry as `confirmed_overstock`. Unconfirmed excess is still rejected. Return and damage subtract from the courier's holding stock; receive subtracts from the truck. Damage also checks the aggregate unless confirmed.
- Other products can be configured using `update public.ice_types set allow_half = false where id = '<product UUID>';` in the normal database administration workflow. No catalog editor changes are included.

## Manual acceptance checks

1. Start with 20 bags on the truck. Type full 14, half 1: card and button show 14.5 bags; remaining preview shows 5.5. Save: both inputs reset to zero, remaining stays 5.5, green success appears, and exactly one movement contains 14 / 1 / 14.5.
2. Set a product's `allow_half` false and reload reference data. Half input is absent; full input fills the row. API requests with half bags are rejected for that product.
3. Save another quantity after step 1: remaining decreases again and a separate movement is created. Retrying the same pending request after a network failure creates only one movement.
4. Click save with all zeros: red validation appears below the button, no RPC. Edit full then half and click Undo: only the last edit is undone. Successful save clears Undo history.
5. Simulate a rejected RPC/offline failure: inputs remain, retry message appears, retry uses the same request key. Enter more than source stock: yellow card warning; cancel confirmation preserves input, confirm allows save.
6. Switch to Burmese: counter labels, balance previews, warnings, confirmation, Undo/Save and success/error feedback are translated. Switching back to Thai preserves inputs and translates the success message.
7. Repeat on return and damage. Their source is courier holding stock; returning increases truck stock. Check 360px and dark mode: no horizontal overflow; equal card heights with image/fallback; 44px-wide, 48px-high step buttons; last card scrolls clear of the fixed save bar.

## Automated verification

```sh
npx vitest run tests/employee-stock-damage.test.tsx tests/employee-live-shop-refresh.test.tsx --maxWorkers=1 --no-file-parallelism
node --test tests/employee-stock-transfer.integration.test.mjs tests/employee-stock-damage-contract.test.mjs
npm run build
```

Database integration tests run the migration in isolated PGlite PostgreSQL, including all three RPCs, split validation, allowHalf, historical totals, source balances, retries across migration and balance refresh, and confirmed overstock. UI tests recover legacy numeric drafts with their original pending request keys and verify Burmese feedback. Browser preview at 360px verified equal card heights and document width of 360px in dark mode.
