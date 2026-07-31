## 2026-07-28 — Collection shop cards, popup, and bill numbers

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/IMG_2972.PNG` (944 × 2048 px), plus the existing POS shop-card pattern in `src/features/employee-delivery/EmployeeShopPicker.tsx`.
- Rendered implementation: [outputs/collection-popup-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-popup-mobile.png).
- Side-by-side evidence: [outputs/collection-reference-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/collection-reference-comparison.png).
- Viewport: 393 × 852 CSS px at device scale factor 1. The 944 × 2048 source was normalized to 393 × 852 only for the comparison board; the implementation screenshot is natively 393 × 852.
- State: courier collection queue with one shop selected and the receive-payment popup open, showing two outstanding bills.
- Full-view comparison evidence: the existing inline payment form and the revised popup were reviewed together at the same normalized mobile size. The revised screen preserves the original blue/white visual system while separating shop selection from payment entry.
- Focused-region evidence: the popup header, bill list, payment fields, file control, close target, and confirm action are all readable at 393 px, so no additional crop was required.

**Findings**

- No actionable P0/P1/P2 differences remain. The popup fits within the mobile viewport, has no horizontal overflow, and does not require internal scrolling for the representative two-bill state.
- The shop image in the visual fixture is intentionally a local test asset. Production uses the existing signed `shop-images` URL and `object-fit: cover`; a storefront icon appears only when a shop has no saved image.

**Required Fidelity Surfaces**

- Fonts and typography: retained the app's Thai font stack and hierarchy. Shop code, name, outstanding total, bill number, and form labels remain distinct and readable without wrapping collisions.
- Spacing and layout rhythm: the popup uses a 393 px bottom-sheet layout, 14–16 px gutters, 48 px form controls, and a 42 px close target. Browser measurement confirmed `bodyScrollWidth = bodyClientWidth = 393`.
- Colors and visual tokens: retained the existing navy text, primary blue action, pale-blue form surface, white cards, and low-contrast borders from the POS and collection screens.
- Image quality and asset fidelity: production shop photos use the existing storage images; standard UI marks use the existing Phosphor icon package. No handcrafted SVG, emoji, or CSS-drawn icon substitutes were added.
- Copy and content: each pending charge now shows a stable bill number, service date, original bill amount, and remaining balance. The queue card shows the number of outstanding bills and total due.

**Interaction And Build Checks**

- Browser: verified the open popup at 393 × 852; no horizontal overflow and no console errors or warnings.
- UI test: opens the popup from a shop card, renders the signed shop photo and both bill numbers, and records a partial payment oldest-first.
- Database integration: the new migration applies to the full financial schema, generated bill numbers match `BYYMMDD-000001`, and both collection queues expose shop image paths and bill numbers.

## 2026-07-29 — Review corrections

- Supersedes the “bill number” terminology above: the pre-payment identifier is a delivery-charge reference, stored as `charge_number` and displayed as “เลขรายการส่ง” in `CYYMMDD-000001` form. It is not an invoice or receipt number.
- The payment popup now moves focus to its close control, traps Tab navigation, makes the underlying page inert, locks body scrolling, supports Escape, and restores focus to the selected shop card.
- The migration backfill is now exercised against an existing historical charge before a replacement charge is inserted. This test exposed and fixed deferred trigger events that had to be flushed before `ALTER TABLE ... SET NOT NULL`.
- Final verification: 175 database/contract tests passed, 133 UI tests passed, and the production build passed.
- Full suite: 174 database/contract tests and 132 UI tests passed.
- `npm run build`: passed.

**Comparison History**

- Initial comparison: no P0/P1/P2 findings; no visual correction loop was required.

**Follow-up Polish**

- P3: Native file-input wording follows the device/browser locale, so its exact label may differ between iOS Safari and desktop preview.

final result: passed

---

## 2026-07-29 — Receive-payment layout refresh

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-29เวลา 18.12.38.png` (provided receive-payment layout reference).
- Intended implementation: `src/FinancialOperations.tsx`, opened from the collection queue with a shop selected.
- Implementation screenshot path: unavailable — the local production route requires an authenticated Supabase session; the available demo route does not expose the financial-operations screen.
- Intended viewport and state: 630 × 742 reference, payment dialog open, cash selected, a received amount entered, and evidence not yet attached.

**Findings**

- [P1] Browser-rendered visual comparison is blocked by the unavailable authenticated collection state. The form was therefore not marked as visually passed from source code or tests alone.

**Required Fidelity Surfaces**

- Fonts and typography: implemented with the existing Noto Sans Thai stack; browser visual verification is pending.
- Spacing and layout rhythm: implemented as a compact single-column payment card with grouped method buttons, amount field, quick values, summary row, and fixed action row; browser visual verification is pending.
- Colors and visual tokens: uses the established blue primary action, pale blue summary surface, green monetary figures, white fields, and existing border tokens; browser visual verification is pending.
- Image quality and asset fidelity: no new raster assets were needed; standard controls use the installed Phosphor icon set.
- Copy and content: payment method, live allocation/change/remaining amounts, reference, evidence, receipt choice, cancel, and confirmation are connected to the existing payment flow.

**Interaction And Build Checks**

- `npm run test:ui -- --run tests/financial-operations.test.tsx`: passed, 13/13.
- `npm run build`: passed.
- Existing record-payment validation, oldest-first allocation, evidence requirements, focus management, automatic receipt printing, dynamic method tabs, and receipt flow remain covered by the focused UI suite.
- Payment evidence is rejected above 5 MB in the dialog, and migration `0114_limit_payment_evidence_to_5mb.sql` applies the same storage limit.

**Implementation Checklist**

- Sign into a collection-enabled account, open one shop's receive-payment dialog, capture it at the reference state, and run the side-by-side visual comparison.

final result: blocked

---

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-23เวลา 12.35.00.png` (legacy damage form) and `/Users/bhusitt./Desktop/ภาพถ่ายหน้าจอ2569-07-23เวลา 12.35.53.png` (the requested transfer-card pattern).
- Intended implementation: the damage/melt tab in `src/ManagerStockControl.tsx`.
- Required rendered implementation screenshot: unavailable.
- Intended viewport: desktop, matching the supplied 2048 × 1280 screenshots.
- State to compare: damage tab selected, a source-location card selected, one or more product quantities selected, note entered, and confirmation summary enabled.

**Findings**

- [P1] Browser-rendered visual comparison is unavailable.
  Location: local demo preview.
  Evidence: the Vite demo server starts successfully on port 4173, but the available in-app browser cannot resolve `terminal.local`; its local-host fallback is blocked by browser URL policy.
  Impact: the revised card layout cannot be captured and compared side by side with the supplied screenshots in this environment.
  Fix: open the demo in a browser that can reach the local server, capture the requested damage state, then compare it with the transfer-card screenshot.

**Required Fidelity Surfaces**

- Fonts and typography: not visually verified.
- Spacing and layout rhythm: not visually verified.
- Colors and visual tokens: not visually verified.
- Image quality and asset fidelity: unchanged existing Phosphor icons and supplied application assets; not visually verified.
- Copy and content: code inspection and UI tests confirm the damage flow exposes source selection, item cards, an optional note, summary, and the damage-specific confirmation label.

**Interaction And Build Checks**

- `npm run test:ui -- tests/manager-stock-control.test.tsx`: passed, 18/18.
- `npm run build`: passed.
- The damage submission test confirms a source-only record, no destination, and an optional note.

**Implementation Checklist**

- Capture the revised damage flow at the target desktop viewport.
- Compare it side by side with the transfer-card reference and resolve any P0/P1/P2 visual differences.

final result: blocked

---

## 2026-07-24 — Ice type layout redesign

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 24 ก.ค. 2569 16_48_10.png`.
- Rendered implementation: [outputs/ice-types-layout-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/ice-types-layout-final.png), captured from the local preview route `?screen=ice-types-layout`.
- Side-by-side evidence: [outputs/ice-types-layout-comparison.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/ice-types-layout-comparison.png).
- Viewport: implementation 1680 × 940 CSS px at device scale factor 1; the 1672 × 941 source was scaled only for the side-by-side review.
- State: desktop, `ชนิดน้ำแข็ง` tab active, first item selected, six active types, one current price row.

**Findings**

- No actionable P0/P1/P2 differences remain. The comparison matches the reference's 247px sidebar, 282px content start, tab row (~167px), metric cards (~225px), split editor start (~331px), compact image row, and fixed bottom action treatment.
- Product thumbnails in the local preview are intentionally placeholders because the preview does not connect to storage. Production continues to render each saved `image_path` through the existing signed-URL flow; this is sample-data variance rather than a layout replacement.

**Required Fidelity Surfaces**

- Fonts and typography: Noto Sans Thai hierarchy, compact labels, and A/B/C section headings match the reference's dense admin UI.
- Spacing and layout rhythm: sidebar, content gutters, card heights, split columns, and price-entry spacing were aligned to the reference viewport.
- Colors and visual tokens: blue active/navigation states, pale metric icon surfaces, white cards, borders, and semantic green/purple pills are preserved.
- Image quality and asset fidelity: existing logo, sidebar artwork, Phosphor icons, and the production image-rendering path are retained; no custom-drawn image substitutes were introduced.
- Copy and content: labels, filters, status badges, price history, and save actions remain coherent and functional.

**Interaction And Build Checks**

- Browser: switched to `ชนิดน้ำแข็ง`, searched for `น้ำแข็งก้อน`, selected the result, and confirmed the form updated; no console warnings or errors.
- `npm run test:ui`: passed, 14 files / 77 tests.
- `npm run build`: passed.

**Follow-up Polish**

- P3: Production thumbnails will naturally reflect each customer's stored ice imagery rather than the static sample imagery shown in the reference.

final result: passed

---

## 2026-07-27 — Today dashboard reference redesign

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 24 ก.ค. 2569 17_28_58.png` (1491 × 1055 px).
- Rendered implementation: [outputs/today-dashboard-reference-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/today-dashboard-reference-final.png), captured from the local demo route `?screen=today-layout` at 1280 × 1087 CSS px, device scale factor 1.
- Responsive implementation: [outputs/today-dashboard-mobile.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/today-dashboard-mobile.png), captured at 390 × 844 CSS px, device scale factor 1.
- State: work session in progress, four populated overview cards, four stock holders, three active staff cards, two action alerts, and four operational shortcuts.
- Full-view comparison evidence: source and implementation were opened together in the visual comparison pass. The source browser chrome was excluded from fidelity judgments; the implementation uses the existing application sidebar and top bar.
- Focused regions reviewed: overview cards, distribution flow, staff panel, stock-holder grid, alert list, and shortcut row. These regions carry the reference's hierarchy and density, so focused review was required.

**Findings**

- No actionable P0/P1/P2 differences remain for the requested desktop layout. The implementation matches the reference's page hierarchy: four summary cards, paired route/team panels, stock and alert panels, and four colored quick actions.
- P3: Production staff cards correctly use the existing user icon because the daily dashboard contract does not currently expose avatar URLs. This avoids introducing fabricated portrait assets; the layout will accommodate avatars if the data contract is extended later.

**Required Fidelity Surfaces**

- Fonts and typography: retained the application's Noto Sans Thai family and compact Thai dashboard scale, with a strong page heading, small supporting labels, and numeric emphasis aligned to the source.
- Spacing and layout rhythm: desktop grid and cards use the reference's compact gutters, rounded white surfaces, low shadows, paired middle rows, and full-width shortcut strip. At 390 px, cards collapse to two columns and panels stack without page overflow.
- Colors and visual tokens: existing blue navigation and stock color, pale blue/green/orange icon surfaces, white cards, green work-status pill, amber alerts, and blue/teal/purple quick actions were mapped to the reference.
- Image quality and asset fidelity: retained the supplied ice logo and sidebar water artwork. Standard UI controls use the existing Phosphor icon set; no handcrafted SVGs, fake portrait images, or CSS artwork were added.
- Copy and content: visible values are tied to the existing daily-dashboard and stock-summary data. The demo route has realistic local data only for visual verification; production still fetches the live RPC data.

**Interaction And Build Checks**

- Browser: verified the rendered desktop and 390 px mobile layouts, opened the overflow menu, and confirmed the cancellation action appears. Browser console: no errors.
- `npm run test:ui`: passed.
- `npm run build`: passed.

**Implementation Checklist**

- Completed: visual hierarchy, responsive layout, data bindings, overflow cancellation menu, alert routing, and operational shortcut routing.

**Follow-up Polish**

- P3: Add employee avatar URLs to `get_daily_work_dashboard` if portrait imagery is required for this screen.

final result: passed

---

## 2026-07-24 — Shop directory layout redesign

**Comparison Target**

- Source visual truth: `/Users/bhusitt./Downloads/ChatGPT Image 24 ก.ค. 2569 09_27_31.png`.
- Rendered implementation: [outputs/shop-layout-final.png](/Users/bhusitt./Downloads/ส่งน้ำแข็ง/outputs/shop-layout-final.png), captured from the local demo route `?screen=shops-layout`.
- Viewport: reference 1672 × 941 px; implementation 1672 × 941 CSS px at device scale factor 1.
- State: desktop card view with eight demo stores, POS readiness metrics, all directory filters visible, and no filter selected.

**Findings**

- [Resolved P1] The first pass wrapped the directory search independently from the filter controls at the source viewport. The toolbar now keeps the search, filters, and view switcher on the same row at desktop width, matching the reference hierarchy.
- [Resolved P2] The initial narrow layout allowed the directory controls to exceed the mobile viewport. The mobile toolbar now stacks the search and uses a two-column filter grid; browser measurement confirmed no horizontal overflow.
- No actionable P0/P1/P2 differences remain for the requested desktop layout. Store summary cards, status colors, compact four-column cards, topbar context controls, sidebar, and directory controls align with the reference's visual structure.

**Required Fidelity Surfaces**

- Fonts and typography: Noto Sans Thai is retained with dense dashboard-scale labels, a clear page title, and compact metadata.
- Spacing and layout rhythm: matched at the 1672 × 941 desktop viewport; the action row, metric row, filter row, and two rows of cards preserve the reference hierarchy.
- Colors and visual tokens: blue primary actions, pale blue/green/orange/red status surfaces, white cards, and low-elevation borders follow the supplied design.
- Image quality and asset fidelity: the supplied logo and sidebar water artwork are retained; standard UI icons use the existing Phosphor icon library. No image substitutions were added.
- Copy and content: status labels are bound to the POS-readiness report in production; the preview uses realistic local sample data solely for the visual route.

**Interaction And Build Checks**

- Browser: searched for `AA12`, verified one matching store, switched to the list view, and confirmed no console errors.
- Responsive browser check: 390 × 844 CSS px; no horizontal page overflow after the mobile toolbar correction.
- `npm run test:ui -- --run tests/shop-settings-card-catalog.test.tsx`: passed, 3/3.
- `node --test tests/shop-card-image-layout.test.mjs`: passed, 1/1.
- `npm run build`: passed.

**Follow-up Polish**

- P3: The demo view intentionally uses eight mock stores; production continues to use the connected store and POS-readiness data.

final result: passed
