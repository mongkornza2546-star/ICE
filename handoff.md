# Handoff: ICE Delivery System

## Status — 23 July 2026

- Admin page **“ผู้ใช้และชนิดน้ำแข็ง”** redesigned with tabs, searchable lists, detail forms, image management, and reference-price history.
- User settings continue to manage existing profiles only. Account creation is intentionally outside this client-side admin page.
- Ice-type metadata, image, and price forms remain independent submit paths; saving a price or image does not resubmit metadata.
- Daily work-session architecture from migrations `0042` and `0043` remains active and documented below.
- Verification: DB tests **137/137**, UI tests **62/62 in 12 files**, production build passed. Build retains existing Vite chunk-size warning.

## Latest rework: admin reference settings

### User profiles

- Search and active-state filtering remain available.
- Admins can update display name, nickname, phone, role, avatar, active state, and courier work-site assignments.
- Current user cannot change their own role or active state.
- No “เพิ่มผู้ใช้” or “ลบผู้ใช้” affordance is shown because no secure account-provisioning or hard-delete flow exists here.

### Ice types

- Header action starts a new ice type only while the ice-type tab is active.
- Summary cards show total, active, and inactive counts from loaded ice-type data.
- Unit remains free text, matching the database `text` contract and existing non-Thai values.
- Metadata form is separate from image and price forms. External metadata submit button targets `ice-type-details-form` explicitly.
- Price status uses `is_active`, `valid_from`, and `valid_to`: `พักใช้งาน`, `กำหนดไว้`, `ปัจจุบัน`, or `สิ้นสุดแล้ว`.
- Non-functional price edit/menu buttons were removed.

### Key files

- [`src/AdminReferenceSettings.tsx`](src/AdminReferenceSettings.tsx)
- [`src/features/admin-reference-settings/components/UserEditor.tsx`](src/features/admin-reference-settings/components/UserEditor.tsx)
- [`src/features/admin-reference-settings/components/IceTypeEditor.tsx`](src/features/admin-reference-settings/components/IceTypeEditor.tsx)
- [`src/features/admin-reference-settings/components/IceTypeImageEditor.tsx`](src/features/admin-reference-settings/components/IceTypeImageEditor.tsx)
- [`src/features/admin-reference-settings/components/IceTypePriceEditor.tsx`](src/features/admin-reference-settings/components/IceTypePriceEditor.tsx)
- [`tests/admin-reference-settings-editor.test.tsx`](tests/admin-reference-settings-editor.test.tsx)

## Daily work-session architecture

### Database and session lifecycle

- `round_type` classifies rounds as `daily` or `special`; legacy rounds are backfilled as `special`.
- Daily rounds use system name `งานประจำวัน`.
- First factory order creates the daily session automatically and moves it to in-progress state.
- `get_daily_work_dashboard(service_date)` returns session, team members, delivery summary, net sales summary, and cancellation state.
- `cancel_daily_work_session(service_date, reason)` is admin-only, requires active factory orders to be reversed first, and records audit data.
- `get_daily_stock_close_state` treats only open legacy `special` rounds as blockers; active daily session does not block day close.
- `close_daily_stock_v2` closes the daily session in the same transaction as stock close.

### UI behavior

- Main manager view is **“งานวันนี้”**.
- Work begins automatically after first factory order; no manual open-work button exists.
- Dashboard refreshes when revisited and shows session status, active members, deliveries, issues, and net sales.
- Admin can cancel an empty work session after reversing its factory order.
- Final stock action is **“ปิดสต๊อกและจบงานวันนี้”**.

### Related files

- [`supabase/migrations/0042_daily_work_session_architecture.sql`](supabase/migrations/0042_daily_work_session_architecture.sql)
- [`supabase/migrations/0043_daily_work_dashboard_and_cancellation.sql`](supabase/migrations/0043_daily_work_dashboard_and_cancellation.sql)
- [`tests/daily-work-session.integration.test.mjs`](tests/daily-work-session.integration.test.mjs)

## Verification commands

```bash
npm test
npm run build
```

`npx vitest run` executes UI tests only; use `npm test` for DB and UI suites together.

## Remaining work

1. Perform browser QA at desktop, tablet, and mobile widths using production-like data.
2. Add server-side account provisioning before exposing an add-user action.
3. Address existing Vite chunk-size warning through route-level code splitting when performance work is scheduled.
