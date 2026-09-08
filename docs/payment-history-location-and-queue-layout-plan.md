# Implementation Plan: Fix คิวเก็บเงิน Layout and Add Payment History Location Filters and Shop Photos

## Goal and scope

Make the employee collection queue easier to scan and let employees find payment history by date, regular-shop building/zone, and text, with shop thumbnails for recognition.

Use the existing queue markup, image URL utilities, and paginated history RPC. The queue layout fix needs CSS changes; its search input already has a class and accessible label. Do not add a shared component abstraction just for this change.

Location-filter decision: ตึก/โซน filters apply to regular shops. Event receipts remain visible with ทุกตึก/ทุกโซน and are searchable by event details. Event location and zone snapshots are display text, not building/zone IDs. Explain this beside the filters: “ตัวกรองตึก/โซนใช้กับร้านประจำ · ค้นหางานอีเวนต์ได้จากช่องค้นหา”.

This plan covers the employee `PaymentHistorySection`; the manager's separate `CollectionDesk` history presentation is outside this UI change.

## Existing behavior and constraints

- Global `label` styling sets `flex-direction: column`. The queue search switches the label to flex but never overrides the direction, stacking the icon and input.
- The queue search also has `grid-column: 1 / -1` and `max-width: 450px`. Changing only its parent's grid cannot put all three controls in one desktop row.
- `get_payment_history` returns JSONB with `items`, `next_cursor`, and `range_summary`. Its `visible` CTE already selects `payment.*`, including `shop_id`, but does not expose that field in the item JSON.
- Event queue records deliberately use null building/zone IDs and event snapshot names. Do not substitute a shop's regular building for an event destination.
- `fetchAllPaymentHistory` collects all pages before returning. `loadPaymentHistory` guards against stale date requests with `historyRequestRef`.
- Changing `historyDate` clears the rows but currently keeps `PaymentHistorySection` mounted. New local filter state must be reset explicitly.

## Database migration

Add `supabase/migrations/0181_payment_history_shop_image_and_location.sql`. Check that the sequence number is still free when implementing.

Use `CREATE OR REPLACE FUNCTION` with the existing `public.get_payment_history(date, date, integer, timestamptz, uuid)` signature and JSONB return type.

### Projection

- Retain `payment.*`. **Do not add `shop.id AS shop_id`**: it duplicates the existing column and makes `returned.shop_id` ambiguous. Add the JSON field using `returned.shop_id` directly.
- Add `shop.image_path AS shop_image_path`, then expose it as the item JSON field `image_path`.
- Add left joins to `public.buildings` and `public.building_zones` using the shop's location IDs. Left joins must preserve receipts without a matching location record.
- For regular payments, return the shop's current `building_id`/`zone_id` and the joined names. These filters represent current shop placement, not historical receipt-location snapshots.
- For event payments, return null `building_id` and `zone_id`; use `stop.event_location_snapshot` as `building_name` and `stop.event_zone_snapshot` as `zone_name` for display. Preserve the existing explicit event fields.
- Return the current shop image for either destination kind when available. It identifies the shop, not necessarily the event booth. Missing images use the UI placeholder.
- Add only these item JSON fields: `shop_id`, `image_path`, `building_id`, `building_name`, `zone_id`, `zone_name`. Keep the existing `shops: { code, name }` object.

### Preserve the RPC contract

Keep active-user and visibility checks, `SECURITY DEFINER`, fixed `search_path`, grants, Bangkok date boundaries, date-range validation, page-size validation, cursor validation, descending `(recorded_at, id)` order, range summaries, and existing event context fields.

Keep location joins one-to-one and retain the existing allocation-derived event snapshot lookup. Do not add location filtering inside the RPC: the frontend already loads the complete selected day, and server filtering would require coordinating item pagination and summaries.

The response change is intended to be additive; verify that through database tests before describing it as backward-compatible. Deploy the migration before relying on the new fields in production. Optional frontend fields allow older payloads to render without photos or location options during rollout.

## Frontend data flow

### `src/features/financial-operations/types.ts`

Add optional nullable string fields `shop_id`, `image_path`, `image_url`, `building_id`, `building_name`, `zone_id`, and `zone_name` to `PaymentHistoryItem`. Keep existing fields and null-safe access to `shops`.

### `src/features/financial-operations/utils.ts`

Generalize the existing helper to `withPublicShopImages<T extends PublicImagePathItem>(items: T[]): Promise<T[]>`, importing the existing `PublicImagePathItem` type.

Keep the existing hybrid Supabase/R2 URL resolution, deduplication, and failure fallback. Do not create another image resolver or require every storage URL to be signed.

### `src/FinancialOperations.tsx`

- Resolve images once, after the pagination loop in `fetchAllPaymentHistory`, using `return withPublicShopImages(items)`.
- Preserve repeated-cursor detection and the request-ID check after the awaited fetch, including image resolution, so an older date cannot overwrite a newer one.
- Existing callers continue to receive enriched rows, including `todayPayments`.
- Add `key={historyDate}` at the employee `PaymentHistorySection` call site. This resets building, zone, and query together on every date change, including previous/next navigation. Ordinary refreshes on the same date should not remount the section.
- Keep the demo data path working with directly supplied image URLs; it bypasses the RPC/image resolver.

## Payment history UI

Modify `src/features/financial-operations/components/FinancialOperationsPanels.tsx`:

1. Add local `buildingId`, `zoneId`, and `query` state.
2. Derive building options from all unfiltered regular payment rows for the selected date, requiring both ID and name. Treat missing `destination_kind` as regular for older payloads. Deduplicate by ID and sort names using the existing Thai locale convention.
3. Derive zone options from regular rows in the selected building. Disable the zone control until a building is selected. Changing the building clears the zone immediately.
4. Do not derive dropdown options from search results; typing must not remove a selected option. On same-date data refresh, ensure IDs no longer present in the available options cannot remain effective hidden filters; invalidate the building and dependent zone, or the zone alone, as appropriate.
5. Match trimmed, case-insensitive search against shop code, shop name, receipt number, and event name/location/zone/booth. Handle null shop and event fields safely.
6. Apply search and selected location filters together. With no building selected, include event receipts; with a building selected, only matching regular receipts qualify.
7. Render the search and dropdowns when the unfiltered day's history has rows. Keep them visible when the filtered result is empty so users can clear the filters.
8. Distinguish “ไม่มีรายการรับเงินในวันที่เลือก” from “ไม่พบรายการตามตัวกรอง”. Show the regular-shop scope explanation beside the filters.
9. Add a `.financial-ops__history-visual` thumbnail inside the existing receipt-summary button. Use a lazy-loaded decorative image with empty alt text, or a storefront placeholder when no URL is available. Keep the shop name as the accessible identification.
10. Group text in `.financial-ops__history-info`. Display building/zone names for regular shops and preserve event details for event receipts.
11. Preserve receipt opening, keyboard interaction, print actions, void permissions, busy-state disabling, amounts, and active/voided status presentation. Filtering changes only the displayed list.

## Styling

Modify `src/index.css`, reusing the queue filter classes for the history controls:

- Set `.financial-ops__queue-filters .financial-ops__queue-search` to `flex-direction: row; align-items: center;` and prevent the icon from shrinking.
- On desktop, set the filter grid to `minmax(260px, 1.5fr) minmax(140px, 1fr) minmax(140px, 1fr)` with `align-items: end` and a 12px gap.
- **Also set the desktop search to `grid-column: auto; max-width: none;`.** Remove or override the old full-row span and 450px limit with sufficient selector specificity.
- At `max-width: 759px`, use two equal columns and set the search to `grid-column: 1 / -1; max-width: none;`. Keep the building and zone controls side-by-side.
- Verify the three-column layout fits the actual content area near the breakpoint, not just the viewport. If it overflows, extend the stacked layout breakpoint rather than clipping controls.
- Center `.financial-ops__shop-arrow` with `top: 50%; bottom: auto; transform: translateY(-50%);` inside the mobile media query only.
- Size history thumbnails at 60×60px with a fixed flex basis, rounded clipping, and `object-fit: cover`. Give text `min-width: 0` and allow appropriate wrapping without overlapping the thumbnail or open label.
- Account for the existing `.financial-ops__list span { display: grid; }` and history text nowrap rules when adding the visual/info wrappers.
- Preserve the mobile history-card column layout, with a divider above the amount/action area. Keep long Thai names, event details, and receipt numbers readable without horizontal overflow.

## Demo fixtures

Update `collectionPayments` in `src/LocalDemoApp.tsx` to cover:

- Multiple regular buildings and at least two zones in one building.
- Both a shop image URL and a missing-image placeholder.
- An event receipt with null location IDs and event snapshot text.
- A second date whose buildings differ from the first date, to exercise reset behavior.
- A long shop name and an active/voided receipt mix.

Keep fixture dates aligned with the demo service date and previous-day navigation.

## Verification

### Database integration

Extend `tests/event-financial-foundation.postgres.mjs` or add an equivalent focused PostgreSQL integration test using the repository's existing harness. The existing harness stops migrations at `0173`; explicitly update migration application to include the new migration and its prerequisites. A test that only reads migration `0171` does not verify this change.

Apply the actual new function and call `get_payment_history`, rather than testing a handwritten replacement query. Cover:

- Regular payment fields, shop image path, and nullable zone data.
- Event fields with null building/zone IDs and correct snapshot names.
- Existing item fields and all top-level response fields retained.
- Pagination across regular/event receipts, including equal timestamps: no missing/duplicate rows and an unchanged range summary across pages.
- Active/voided records and existing visibility restrictions.
- The projection executes successfully, specifically preventing duplicate `shop_id` aliases.

### UI and data-path tests

Add `tests/payment-history-filters.test.tsx` and extend the relevant FinancialOperations tests to cover:

- Image and placeholder rendering, including older payloads without the added fields.
- Building/zone filters, combined search, zone reset after building changes, and null-safe text matching.
- Event receipts visible under all locations and discoverable by event text, but excluded by regular-building selections.
- No matching results while filters remain accessible; clearing filters restores rows.
- Select building A, change to a date containing only B, and verify query/building/zone reset and B's receipts appear. Exercise the parent date-change path, not only isolated component rerenders.
- A same-date refresh removes a selected location without leaving an invisible stale filter.
- Mocked multi-page RPC responses reach the image resolver and history UI; stale date responses cannot replace the selected date's rows.
- Receipt open/print/void actions continue to receive the correct filtered payment and respect existing permissions.

### Commands

- `npm run test:ui`
- `node --test tests/*.test.mjs`
- `npm run test:postgres-event-financial` when extending that harness; otherwise run the new PostgreSQL integration test explicitly as well.
- `npm run build`

The existing `financial-ops-ipad-layout.test.mjs` checks shop-photo CSS only. Its passing result is not evidence that the new search grid or payment history layout works.

### Browser verification

Start demo mode with `npm run dev:demo` and open `http://localhost:5173/?screen=employee-collection-layout`.

- At 390×844, verify the search is approximately 44px tall, its icon is aligned left, location controls share a row, and card arrows are vertically centered.
- In history, verify thumbnails/placeholders, long text, filter scope text, no-result recovery, event search, and changing dates after selecting a building/zone.
- At 1280×800, verify search/building/zone controls share one row and the search can grow beyond 450px.
- Check around the 759/760px breakpoint and at an iPad width for overflow and image/text overlap.
- Verify keyboard labels, focus, and receipt actions. Inspect screenshots/computed layout; do not rely on jsdom for geometry.

## Completion criteria

The migration executes against the real schema and preserves the existing RPC contract; location filtering follows the explicit regular/event distinction; date changes cannot leave stale filters; and the queue and history layouts pass the specified visual checks.
