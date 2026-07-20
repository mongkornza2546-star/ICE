# Handoff: Closed-round stock snapshots and stock-control UI

## Current objective

Complete the stock-control layout overhaul without changing the existing stock-ledger semantics: live views show day-wide stock, while a selected closed round shows the frozen day-wide snapshot captured at that round's close time.

## Product decisions

- Stock remains a day-wide ledger keyed by `service_date`; it is not owned by a delivery round.
- A delivery round is identified by `round_id`, even when displayed names such as `04:00` are duplicated.
- The live view is labelled `สต๊อกปัจจุบันของวัน` and shows the current day-wide balance.
- A closed round is read-only and is labelled `สต๊อกทั้งวัน ณ เวลาปิดรอบ`.
- Factory receipts use the round-independent `FactoryOrderPage`; the redundant integrated stock-control tab has been removed.
- Manual `ส่งคืนโรงงาน` remains available in addition to the automatic return performed by daily close.
- **Daily Stock Closure Validation:** The daily stock closure process relies on actual counts recorded in the "ตรวจนับจริง" tab. A count becomes stale after any stock-affecting movement or delivery at that location; missing or stale locations require a fresh supervisor confirmation before the backend uses system balances.

The operating rules are also recorded in [README.md](README.md) and [docs/phase-0/operating-rules.md](docs/phase-0/operating-rules.md).

## Implemented work

### Closed-round snapshots

- [supabase/migrations/0026_round_stock_snapshots.sql](supabase/migrations/0026_round_stock_snapshots.sql) adds snapshot tables, backfills closed rounds, captures balances atomically at close time, and makes `get_stock_control_summary` return live or snapshot data as appropriate.
- [supabase/migrations/0027_cancel_delivery_round.sql](supabase/migrations/0027_cancel_delivery_round.sql) captures a snapshot when an unused round is cancelled and keeps cancelled rounds out of stock history.
- `ManagerStockControl` hides all mutation forms for a selected closed round.
- `RoundWorkspace` distinguishes the day-wide live view from round history and keeps live operations associated with an appropriate round for audit provenance.

### Stock-control layout

- [src/stock-layout.css](src/stock-layout.css) contains the stock-specific panels, location cards, action tabs, form grids, refresh control, and mobile layout.
- [src/RoundWorkspace.tsx](src/RoundWorkspace.tsx) renders the redesigned round selector and selected-round details in stock mode.
- [src/ManagerStockControl.tsx](src/ManagerStockControl.tsx) renders location balances as cards and exposes transfer, damage, physical count, and factory return actions as tabs.
- Each movement renders only the endpoints its backend contract accepts:
  - transfer: source and destination
  - damage: source to `null`, with a required note
  - factory return: active truck to `null`
- The refresh control reloads the stock summary, count history, count readiness, and daily-close state RPCs. Live data shows the successful client load time; closed snapshots show `snapshot_at`.
- [tests/manager-stock-control.test.tsx](tests/manager-stock-control.test.tsx) submits every available stock-control movement path and verifies the RPC payload. It also checks the day-wide heading, manual refresh, current-count close, stale-count override, and service-date reset.

### Actual Count & Daily Closure UI Refinement

- Updated the "ตรวจนับจริง" tab to display "จุดที่ต้องการตรวจนับ" for clarity.
- Removed redundant inputs from the "ปิดสต๊อกสิ้นวัน" section. Instead, a summary table uses server-computed readiness for every active location, independent of the 20-row history feed.
- [supabase/migrations/0031_daily_stock_count_readiness.sql](supabase/migrations/0031_daily_stock_count_readiness.sql) marks counts stale after later stock changes and derives the close payload atomically while holding the service-date lock.
- Introduced a quick action that routes the user to the first missing or stale location.
- Added a supervisor override checkbox to use current system quantities for missing or stale locations. The confirmation resets when the service date changes.

## Verification

- `npx vitest run tests/manager-stock-control.test.tsx` passed: 7 tests.
- `npm run test:ui` passed: 5 files, 33 tests.
- `node --test tests/daily-stock-count-readiness-contract.test.mjs` passed: 3 tests.
- `node --test tests/factory-order-contract.integration.test.mjs` passed: 12 tests.
- `node --test tests/round-stock-snapshots.integration.test.mjs` passed: 1 test.
- `node --test tests/cancel-delivery-round.integration.test.mjs` passed: 5 tests.
- `npm run build` passed. Vite still reports the existing warning that a generated chunk exceeds 500 kB.
- `git diff --check` passed.

The relevant daily-close assertion in `tests/manager-contracts.test.mjs` passes. The complete file remains red with 18/27 passing because nine existing source-regex assertions cover unrelated refactors in the dirty worktree; therefore the full `npm test` command is not reported as green.

## Deployment note

Apply `0026_round_stock_snapshots.sql`, then `0027_cancel_delivery_round.sql`, before relying on closed-round history. Migration 0026 backfills existing closed rounds; later closures and cancellations capture snapshots in the same transaction as their state change. Apply `0031_daily_stock_count_readiness.sql` after the parallel `0030_pos_delivery_transactions.sql`; authenticated daily-close clients then use `close_daily_stock_from_latest_counts`.

## Pending items

- `ศูนย์ราชการ` in the selected-round card is still hardcoded because the current `DeliveryRound` model has no center field.

## Worktree caution

The worktree is intentionally dirty and contains parallel user work. Preserve existing changes and do not reset or broadly clean the tree. At the time of this handoff the stock-layout work touches `handoff.md`, `src/ManagerStockControl.tsx`, `src/RoundWorkspace.tsx`, `src/index.css`, `src/stock-layout.css`, `tests/manager-contracts.test.mjs`, and `tests/manager-stock-control.test.tsx`.
