# Paid delivery cancellation — 2026-10-06

## Symptom and cause

An admin could cancel a paid end-of-day or credit delivery, enter a new
delivery, and collect again. The screenshot shows sales of ฿400 and receipts
of ฿475. Read-only inspection of the live accounting UI confirmed these records
for BB1 (ร้านข้าวแกง CK), service date 2026-10-06:

| Record | Time (Bangkok) | Amount | Observed state |
| --- | --- | ---: | --- |
| INV2610-00335 | 06:02 | ฿200 | Active, paid |
| INV2610-00386 | 10:37 | ฿100 | Active, paid |
| INV2610-00397 | 12:32 | ฿50 | Active, paid |
| INV2610-00401 | 13:02 | ฿75 | Cancelled/replaced; 1.5 bags of โม่ |
| REC2610-00300 | 14:33 | ฿425 | Active; immutable receipt lists the four INV above |
| REF-1D422E76 | 16:12 | Linked to INV2610-00401 | Pending refund; no cash out recorded |
| INV2610-00409 | 16:12 | ฿50 | Active, paid; 1 bag of โม่ |
| REC2610-00307 | 16:12 | ฿50 | Active |

Thus active invoices total ฿400, while active receipts total ฿475. The original
receipt now reduces receivables by ฿350 but still records ฿425 cash received.
The stored receipt snapshot confirms that the cancelled ฿75 bill was included
in the original collection. On 2026-10-07 the user confirmed actual receipts
were ฿400. The historical repair is prepared below; it has not been committed.

Migration 0194 changed delivery correction to cancel-and-re-enter, but retained
the earlier permission for managers to cancel paid bills. The real
`apply_open_delivery_correction` RPC removed the original payment allocations
and created pending refund obligations while preserving the active receipt.
The dialog blocked paid immediate sales only. Consequently, entering a new
delivery did not reuse the old payment and could lead to another receipt.

The old test explicitly expected paid admin cancellation to succeed, so it
protected the obsolete correction/refund policy instead of the cancel-only rule.

## Fix

- Migration 0210 makes any positive active payment allocation block cancellation
  for every role and payment term, including partial payments.
- The shared context feeds regular/event eligibility and preview. The write RPC
  rechecks preview after acquiring the existing financial-shop transaction lock,
  before moving allocations or changing delivery/stock/refund records.
- The dialog independently blocks paid bills, including when the server returns
  stale eligibility, and explains that payment records must be reviewed first.
- Unpaid cancellation and retry behavior are preserved. A mistaken receipt that
  was properly voided no longer contributes an active allocation.

## Experiment ledger

1. Added assertions that paid admin bills cannot be cancelled: failed because
   the existing context returned `can_cancel = true`.
2. Tested end-of-day and partially paid credit dialogs: both incorrectly showed
   the confirm button; the immediate-payment control already blocked it.
3. Ran the real cancellation RPC from migration 0128 against a PGlite fixture:
   paid admin cancellation succeeded instead of rejecting. This establishes a
   write-path defect independently of accounting report rendering.
4. Applied 0210 and the dialog guard: the regression cases passed.
5. Checked all 3 roles × 3 payment terms × full/partial payment × regular/event
   write routes, including payment arriving after an eligible preview. Rejected
   requests preserve the delivery and allocation and create no refund/revision.
   The integration fixture includes the existing immediate-sale RPC guard.
6. Checked cancellation after receipt voiding and idempotent retry: passed.

Verification: 86 passing tests across cancellation integration, cancellation UI, accounting
summary tests, delivery-to-payment handoff tests, compatibility fence tests, and
production build. PGlite verifies sequential interleavings; simultaneous
PostgreSQL sessions were not exercised in this change.

## Rollout and existing records

Apply `supabase/migrations/0210_block_paid_delivery_cancellation.sql` and deploy
the frontend together. Neither production deployment nor production data repair
has been performed as part of this local change. The live system was inspected
read-only; no delivery, receipt, or refund was modified.

The fix does not erase old receipts or silently reduce gross receipts to sales.
For the affected shop/date, reconcile the cancelled delivery's INV, its original
REC, `payment_allocation_changes`, `refund_obligations`/`refund_settlements`, and
the replacement delivery's REC against the money actually received/returned.
Existing refund-linked receipts have restrictions on voiding; do not bypass
these by deleting rows or marking a refund settled without an actual refund.

## Historical repair prepared on 2026-10-07

`supabase/scripts/repair_bb1_2026_10_06_receipt.sql` defaults to a rollback-only
dry run. It is limited to this shop, date, two receipt numbers, and the known
refund UUID. The intended result is:

- Keep REC2610-00300 and its original ฿425 snapshot, mark the receipt voided,
  and append an audit record linking the replacement.
- Void the erroneous pending ฿75 refund. Do not create a refund settlement.
- Restore the original ฿75 allocation on the now-void receipt as historical
  evidence, preserving the database's allocation conservation rule.
- Issue a replacement receipt for ฿350 allocated to the three valid invoices.
  Use business date 2026-10-06; retain the actual repair entry time separately.
- Keep REC2610-00307 for ฿50. Active receipts then total ฿400.
- Do not modify delivery, stock, invoice prices, or issued receipt snapshots.

The transaction checks the exact original state, locks the shop and receipts,
rejects actual refund settlements and frozen cash reconciliation, forces all
deferred financial constraints, and supports a checked idempotent replay.
Four local PGlite integration tests passed: rollback/commit/replay and rejection
when a real refund exists, cash reconciliation is frozen, or the daily total
has changed. Actual allocation integrity and receipt immutability functions
are loaded from the project migrations.

Production preflight confirmed the active repair administrator and pending
refund `1d422e76-a8c5-47cf-9dc9-0664c45dca1a` for ฿75. Production mutation is
pending an uninterrupted Safari session; the user was using other tabs during
inspection. No repair transaction has been executed in production.
