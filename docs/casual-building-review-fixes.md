# Casual building review corrections — 0251

Apply `supabase/migrations/0251_casual_building_review_fixes.sql` once after 0249.
0249 has already been applied in SQL Editor; do not run it again. 0250 concerns
collection queues and is not a dependency of this correction. Deploy the updated
frontend after 0251. No historical backfill or snapshot rewrite is performed.

## Causes and corrections

- Building totals previously added the visible page's shops to all casual sales
  for the building. The server now reads every active shop in that building,
  batching through the existing daily reader in groups of at most 500. Sales,
  cash, transfers, tank handoffs and item quantities retain the existing reader's
  rules. The UI uses `shop_days` and shows an unavailable total if that field is
  absent, instead of presenting a partial-page total as the whole building.
- Receipts followed `cash_received_by`, but refunds followed the user pressing
  confirm. New cash refunds carry `cash_refunded_by`; `confirmed_by`, void actor
  and audit actor still identify the person recording the action. Managers can
  select the actual refunder, couriers can select only themselves. The original
  cash recipient can find, print and void an admin-entered sale. Unrelated users
  cannot. Old clients default to their own cash ownership; historical refunds
  keep the previous `confirmed_by` fallback. No frozen daily-close data changes.
- Loose-sale stock conversion runs across a holding location, so allocating its
  completed bags and remaining money to individual buildings made B change when
  A was voided. Building rows now display only measured quantities; loose sales
  show count and money with “ไม่ระบุจำนวน”. Global stock conversion and legacy
  projections are unchanged.

## Validation

Regression coverage exercises the 101-shop page change, 501 shops across server
batches using the real daily reader, cash/QR and tank totals, cross-building voids,
admin-recorded refunds, recipient permissions, retries, immutable records,
closed-day rejection, evidence requirements, and upgrading an existing 0249
installation with pre-existing refunds. Existing sales/refunds/receipt JSON is
compared before and after migration, and old idempotency keys still replay.

The original tests covered isolated pages and sale recording, but missed the
page boundary, the full receipt-to-refund ownership path, and coupling between
buildings through a shared stock bucket. These are now tested at those seams.
