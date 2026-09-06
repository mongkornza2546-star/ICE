# Admin and manager fixes — 2026-09-06

Changes are limited to the seven findings in the admin/round-lead review.

| Finding | Cause | Fix | Regression coverage |
| --- | --- | --- | --- |
| Daily close could submit without counting | Actual stock and cash fields defaulted to expected values | Start blank, require every count including explicit zero, validate half-bag/cent precision, retain variance reasons | `daily-close-reconciliation.test.tsx` |
| Refund references moved between shops | Every refund row shared one method/reference state | Store each draft by refund obligation ID and clear only the successfully submitted draft | `refund-queue-drafts.test.tsx` |
| Dashboard net sales ignored closed-period adjustments | Dashboard summed immutable `original_amount` | Migration 0174 uses `effective_delivery_charge_amount` for totals and recent bill amounts | `manager-admin-improvements.integration.test.mjs` |
| Mounted stock screen stayed on the previous day | Business date was initialized once in local device time | Share a Bangkok-date hook; refresh on timer, focus, visibility; reload references and reset the stock workspace on date change | `manager-stock-date.test.tsx` |
| Dashboard missed changes from other devices | Only local window events invalidated the screen | Fetch current data every 30 seconds while active and visible, and on focus/reconnect; provide manual refresh and last-updated time | `manager-dashboard-refresh.test.tsx` |
| Daily-close warnings used obsolete per-location counts | Dashboard readiness came from legacy location snapshots | Derive the displayed close status and reminder from the aggregate closure; suppress empty-stock alerts after closure | `manager-dashboard-refresh.test.tsx` |
| Bulk payment setup replaced unrelated evidence rules | Client upsert sent fixed evidence defaults and creator for every shop | Choose terms/credit and/or payment-method groups; preview affected shops/values; one admin-only atomic RPC locks and merges the selected groups | `bulk-payment-patch.test.tsx`, `manager-admin-improvements.integration.test.mjs` |

The original UI repros failed on untouched count fields, cross-row refund changes, stale dates, missing automatic reload, and legacy count warnings. The SQL repro returned 1,000 instead of 800 after a 200 adjustment. These cases now have executable regression coverage. Previous tests covered individual submissions but did not cover these combinations.

## Deployment order

1. Apply `0174_manager_dashboard_effective_sales.sql` and `0175_bulk_payment_profile_patch.sql` to the target database using the project's normal migration process.
2. Deploy the frontend build after the migrations. Bulk payment setup requires the new `bulk_update_shop_payment_profiles` RPC; it deliberately does not fall back to the old destructive full-profile upsert.
3. Smoke-test with an admin and a round lead. The new bulk RPC is admin-only; the existing dashboard remains available to both roles.

The migrations preserve original delivery bills, per-shop evidence requirements, profile creators, and existing update-audit triggers. Existing shops may change either group independently. A shop without any payment profile must initialize both groups; its evidence rules use database defaults. Invalid or inactive shops and invalid profiles roll back the entire bulk operation.

## Validation commands

```sh
node --test --test-concurrency=1 tests/*.test.mjs
npx vitest run --maxWorkers=1 --no-file-parallelism
npm run build
```

Database regression coverage runs in isolated PGlite fixtures. It does not apply migrations to a live Supabase project or prove live deployment state.

Validation result: 151 Node/SQL tests and 209 UI tests passed; the production build and `git diff --check` passed. A focused SQL rerun also confirmed that the dashboard migration preserves the existing event destination summary, and that bulk edits retain a different original creator and roll back an actual preceding update when a later shop fails validation. The dashboard was visually checked in the local demo. Live Supabase migrations and production deployment were not performed.
