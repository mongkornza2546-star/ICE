# Handoff: Closed-round stock snapshots

## Current objective

Continue and, if appropriate, deploy the change that makes a closed delivery round show a frozen stock snapshot rather than the live stock balance of its service date.

## Product decision

- Stock remains a day-wide ledger keyed by `service_date`.
- A delivery round is identified internally by `round_id`, even when its displayed name (for example, `04:00`) is duplicated.
- Selecting an open round shows the live day-wide stock.
- Selecting a closed round shows the day-wide stock **at that round's `closed_at`**, read-only. It is not stock owned by that round.
- The stock workspace also has a separate “สต๊อกปัจจุบันของวัน” view for live daily operations.

The rationale and operating rules are recorded in [README.md](README.md) and [docs/phase-0/operating-rules.md](docs/phase-0/operating-rules.md).

## Implemented work

- [supabase/migrations/0026_round_stock_snapshots.sql](supabase/migrations/0026_round_stock_snapshots.sql) adds snapshot tables, backfills already-closed rounds from the ledger at their close time, timestamps ledger changes at their serialized statement time, replaces `close_delivery_round` to capture location/type balances atomically, and makes `get_stock_control_summary` return either live or snapshot data.
- [supabase/migrations/0027_cancel_delivery_round.sql](supabase/migrations/0027_cancel_delivery_round.sql) preserves the closed-round invariant by capturing a snapshot when an unused round is cancelled; cancelled rounds remain hidden from stock history.
- [src/ManagerStockControl.tsx](src/ManagerStockControl.tsx) renders closed rounds as history-only, without movement, count, or day-close inputs.
- [src/RoundWorkspace.tsx](src/RoundWorkspace.tsx) distinguishes the daily live view from a round-history view, shows open/close times, and keeps live operations associated with an appropriate round for audit provenance.
- [src/hooks/useReferenceData.ts](src/hooks/useReferenceData.ts) fetches `closed_at`; [src/types/app.ts](src/types/app.ts) includes snapshot metadata.
- [tests/round-stock-snapshots.integration.test.mjs](tests/round-stock-snapshots.integration.test.mjs) applies migrations 0026 and 0027 together, verifies that a closed round stays at 100 while the live daily balance later changes to 80, rejects stale transaction timestamps at the snapshot boundary, and confirms cancelled rounds satisfy the snapshot invariant.
- [tests/manager-contracts.test.mjs](tests/manager-contracts.test.mjs) includes a focused contract assertion for the new behavior.

## Verification completed

- `node --test tests/round-stock-snapshots.integration.test.mjs` passed.
- `node --test tests/cancel-delivery-round.integration.test.mjs` passed: 3 tests.
- Focused `manager-contracts` snapshot test passed.
- `npm run test:ui` passed: 25 tests.
- `npx tsc -b --pretty false`, `npm run build`, and `git diff --check` passed.

`npm test` remains red because of unrelated existing contract/integration failures outside this snapshot work. Do not treat that result as a regression of the snapshot implementation without first isolating the failing test files.

## Deployment note

Apply migrations `0026_round_stock_snapshots.sql` and then `0027_cancel_delivery_round.sql` to Supabase before relying on the UI. Migration 0026 backfills closed rounds; new closures and cancellations capture snapshots in the same transaction as their state change.

## Worktree caution

The worktree is intentionally dirty and contains parallel user work, including image-management changes, half-bag counts, audit artifacts, and a newly present `0027_cancel_delivery_round.sql`. Preserve these changes; do not reset or broadly clean the tree.

## Suggested skills

- `karpathy-guidelines` for any surgical follow-up changes in this dirty worktree.
- `diagnose` if investigating the unrelated full-suite failures.
- `debug-mantra` if reproducing a production mismatch between a closed-round snapshot and the ledger.
