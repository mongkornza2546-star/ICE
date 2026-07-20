# Handoff: Closed-round stock snapshots and stock-control UI

## Current objective

Complete the stock-control layout overhaul without changing the existing stock-ledger semantics: live views show day-wide stock, while a selected closed round shows the frozen day-wide snapshot captured at that round's close time.

## Product decisions

- Stock remains a day-wide ledger keyed by `service_date`; it is not owned by a delivery round.
- A delivery round is identified by `round_id`, even when displayed names such as `04:00` are duplicated.
- The live view is labelled `สต๊อกปัจจุบันของวัน` and shows the current day-wide balance.
- A closed round is read-only and is labelled `สต๊อกทั้งวัน ณ เวลาปิดรอบ`.
- The integrated `รับจากโรงงาน` tab uses `record_stock_movement` and therefore requires an open round. The separate `FactoryOrderPage` remains the round-independent factory-order workflow.
- Manual `ส่งคืนโรงงาน` remains available in addition to the automatic return performed by daily close.

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
- [src/ManagerStockControl.tsx](src/ManagerStockControl.tsx) renders location balances as cards and exposes transfer, factory receipt, damage, physical count, and factory return actions as tabs.
- Each movement renders only the endpoints its backend contract accepts:
  - transfer: source and destination
  - factory receipt: factory (`null`) to an active truck
  - damage: source to `null`, with a required note
  - factory return: active truck to `null`
- The refresh control reloads the three stock summary RPCs. Live data shows the successful client load time; closed snapshots show `snapshot_at`.
- [tests/manager-stock-control.test.tsx](tests/manager-stock-control.test.tsx) submits every movement path through the rendered form and verifies the RPC payload. It also checks the day-wide heading and manual refresh.

## Verification

- `npx vitest run tests/manager-stock-control.test.tsx` passed: 6 tests.
- `npm run test:ui` passed: 5 files, 32 tests.
- `node --test tests/factory-order-contract.integration.test.mjs` passed: 12 tests.
- `node --test tests/round-stock-snapshots.integration.test.mjs` passed: 1 test.
- `node --test tests/cancel-delivery-round.integration.test.mjs` passed: 5 tests.
- The closed-round stock assertion in `tests/manager-contracts.test.mjs` passes after following the heading into `ManagerStockControl`. The complete file remains red with 18/27 passing because nine existing source-regex assertions cover unrelated refactors elsewhere in the dirty worktree.
- `npm run build` passed. Vite still reports the existing warning that a generated chunk exceeds 500 kB.
- `git diff --check` passed.

Do not describe the full `npm test` command as green until the nine unrelated `manager-contracts` assertions are reconciled with their current implementations.

## Deployment note

Apply `0026_round_stock_snapshots.sql`, then `0027_cancel_delivery_round.sql`, before relying on closed-round history. Migration 0026 backfills existing closed rounds; later closures and cancellations capture snapshots in the same transaction as their state change. Apply subsequent migrations in numeric order as usual.

## Pending items

- `ศูนย์ราชการ` in the selected-round card is still hardcoded because the current `DeliveryRound` model has no center field.
- `scratch.tsx` is an untracked one-line scratch file. Confirm ownership before deleting it.

## Worktree caution

The worktree is intentionally dirty and contains parallel user work. Preserve existing changes and do not reset or broadly clean the tree. At the time of this handoff the stock-layout work touches `handoff.md`, `src/ManagerStockControl.tsx`, `src/RoundWorkspace.tsx`, `src/index.css`, `src/stock-layout.css`, `tests/manager-contracts.test.mjs`, and `tests/manager-stock-control.test.tsx`; `scratch.tsx` is also untracked.
